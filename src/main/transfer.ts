import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { Transfer, ProtocolMessage } from '../shared/types.js';
import { NetworkManager } from './network.js';
import { AppDatabase } from './database.js';
import { encodeChunk, ChunkMessage } from './protocol.js';
import { packDirectoryToTar, extractTarArchive } from './archive.js';

// High-speed LAN optimized chunk size (4 MB)
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_PIPELINE_WINDOW = 4; // 4 parallel chunks in flight (16 MB window)

export function getUniqueFilePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let targetPath = path.join(dir, fileName);
  let counter = 1;

  while (fs.existsSync(targetPath)) {
    targetPath = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }

  return targetPath;
}

export function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: DEFAULT_CHUNK_SIZE });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

interface OutboundTransferSession {
  transfer: Transfer;
  filePath: string;
  isTempFile: boolean;
  nextChunkToSend: number;
  acknowledgedCount: number;
  inFlightChunks: Set<number>;
  paused: boolean;
  cancelled: boolean;
  pipelineResolver: (() => void) | null;
  lastProgressTime: number;
  lastTransferredBytes: number;
}

interface InboundTransferSession {
  transfer: Transfer;
  partPath: string;
  finalPath: string;
  fd: number;
  completedCount: number;
  lastProgressTime: number;
  lastTransferredBytes: number;
}

export class TransferManager extends EventEmitter {
  private downloadDir: string;
  private outboundSessions: Map<string, OutboundTransferSession> = new Map();
  private inboundSessions: Map<string, InboundTransferSession> = new Map();

  constructor(
    private network: NetworkManager,
    private db: AppDatabase,
    customDownloadDir?: string
  ) {
    super();
    this.downloadDir = customDownloadDir || path.join(os.homedir(), 'Downloads', 'MultiClip');
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    this.registerNetworkHandlers();
  }

  public getDownloadDir(): string {
    return this.downloadDir;
  }

  private registerNetworkHandlers(): void {
    this.network.on('message', ({ deviceId, message }) => {
      this.handleProtocolMessage(deviceId, message);
    });

    this.network.on('chunk', ({ deviceId, chunk }) => {
      this.handleInboundChunk(deviceId, chunk);
    });
  }

  private handleProtocolMessage(deviceId: string | null, message: ProtocolMessage): void {
    switch (message.type) {
      case 'TRANSFER_REQUEST':
        this.handleTransferRequest(deviceId, message.payload as Record<string, any>);
        break;
      case 'TRANSFER_ACCEPT':
        this.handleTransferAccept(message.payload as Record<string, any>);
        break;
      case 'TRANSFER_REJECT':
        this.handleTransferReject(message.payload as Record<string, any>);
        break;
      case 'CHUNK_ACK':
        this.handleChunkAck(message.payload as Record<string, any>);
        break;
      case 'TRANSFER_PAUSE':
        this.handleRemotePause(message.payload as Record<string, any>);
        break;
      case 'TRANSFER_RESUME':
        this.handleRemoteResume(message.payload as Record<string, any>);
        break;
      case 'TRANSFER_CANCEL':
        this.handleRemoteCancel(message.payload as Record<string, any>);
        break;
      case 'TRANSFER_COMPLETE':
        this.handleRemoteComplete(message.payload as Record<string, any>);
        break;
      case 'REQUEST_FILE':
        this.handleRequestFile(deviceId, message.payload as Record<string, any>);
        break;
      default:
        break;
    }
  }

  private async handleRequestFile(deviceId: string | null, payload: Record<string, any>): Promise<void> {
    if (!deviceId) return;
    const { filePath } = payload;
    if (!filePath || !fs.existsSync(filePath)) {
      console.log(`[WARN] Peer requested non-existent file: ${filePath}`);
      return;
    }

    try {
      await this.startOutboundTransfer(deviceId, filePath);
    } catch (err) {
      console.log(`[WARN] Failed to start requested transfer to ${deviceId}: ${(err as Error).message}`);
    }
  }

  public requestFileFromPeer(sourceDeviceId: string, remoteFilePath: string): void {
    this.network.sendMessage(sourceDeviceId, {
      type: 'REQUEST_FILE',
      payload: { filePath: remoteFilePath },
    });
  }

  // --- Outbound Transfers (Sender) ---

  public async startOutboundTransfer(targetDeviceId: string, filePath: string): Promise<Transfer> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    const isFolder = stats.isDirectory();
    const local = this.network.getLocalInfo();
    const target = this.network.getDevice(targetDeviceId);

    if (!target) {
      throw new Error(`Target device not found: ${targetDeviceId}`);
    }

    const transferId = crypto.randomUUID();
    let actualPath = filePath;
    let actualSize = stats.size;
    let fileName = path.basename(filePath);
    let folderName: string | undefined;
    let isTempFile = false;

    // Automatic zero-RAM streaming folder packer
    if (isFolder) {
      folderName = path.basename(filePath);
      fileName = `${folderName}.tar`;
      const tempDir = path.join(this.downloadDir, '.temp_archive');
      const tempTarPath = path.join(tempDir, `${folderName}_${transferId.slice(0, 8)}.tar`);
      actualSize = await packDirectoryToTar(filePath, tempTarPath);
      actualPath = tempTarPath;
      isTempFile = true;
    }

    const totalChunks = Math.ceil(actualSize / DEFAULT_CHUNK_SIZE) || 1;

    const transfer: Transfer = {
      id: transferId,
      sourceDeviceId: local.id,
      sourceDeviceName: local.name,
      destinationDeviceId: target.id,
      destinationDeviceName: target.name,
      fileName,
      size: actualSize,
      transferred: 0,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks,
      status: 'pending',
      isFolder,
      folderName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db.saveTransfer(transfer);
    this.emit('transfer_updated', transfer);

    this.outboundSessions.set(transferId, {
      transfer,
      filePath: actualPath,
      isTempFile,
      nextChunkToSend: 0,
      acknowledgedCount: 0,
      inFlightChunks: new Set(),
      paused: false,
      cancelled: false,
      pipelineResolver: null,
      lastProgressTime: Date.now(),
      lastTransferredBytes: 0,
    });

    // Send TRANSFER_REQUEST
    this.network.sendMessage(targetDeviceId, {
      type: 'TRANSFER_REQUEST',
      payload: {
        transferId,
        fileName,
        fileSize: actualSize,
        chunkSize: DEFAULT_CHUNK_SIZE,
        totalChunks,
        isFolder,
        folderName,
      },
    });

    return transfer;
  }

  private handleTransferAccept(payload: Record<string, any>): void {
    const { transferId, startChunkIndex } = payload;
    const session = this.outboundSessions.get(transferId);
    if (!session) return;

    session.transfer.status = 'transferring';
    session.nextChunkToSend = typeof startChunkIndex === 'number' ? startChunkIndex : 0;
    session.acknowledgedCount = session.nextChunkToSend;
    session.lastProgressTime = Date.now();
    session.lastTransferredBytes = session.transfer.transferred;

    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    this.streamOutboundPipelined(session);
  }

  private handleTransferReject(payload: Record<string, any>): void {
    const { transferId, reason } = payload;
    const session = this.outboundSessions.get(transferId);
    if (!session) return;

    session.transfer.status = 'cancelled';
    session.transfer.error = reason || 'Transfer rejected by peer';
    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    if (session.isTempFile) {
      try { fs.unlinkSync(session.filePath); } catch {}
    }
    this.outboundSessions.delete(transferId);
  }

  /**
   * Pipelined chunk streaming with sliding window:
   * Keeps up to MAX_PIPELINE_WINDOW chunks in flight to saturate LAN bandwidth (300+ MB/s).
   */
  private async streamOutboundPipelined(session: OutboundTransferSession): Promise<void> {
    const { transfer, filePath } = session;

    while (session.acknowledgedCount < transfer.totalChunks && !session.paused && !session.cancelled) {
      // While window has space, dispatch chunks into the TCP socket
      while (
        session.inFlightChunks.size < MAX_PIPELINE_WINDOW &&
        session.nextChunkToSend < transfer.totalChunks &&
        !session.paused &&
        !session.cancelled
      ) {
        const chunkIndex = session.nextChunkToSend;
        session.nextChunkToSend++;
        session.inFlightChunks.add(chunkIndex);

        const start = chunkIndex * transfer.chunkSize;
        const end = Math.min(start + transfer.chunkSize - 1, transfer.size - 1);
        const currentChunkSize = transfer.size === 0 ? 0 : end - start + 1;

        // Zero-copy chunk stream read directly from disk
        const chunkBuffer = await this.readChunkStream(filePath, start, end);

        const chunkFrame = encodeChunk(
          {
            transferId: transfer.id,
            chunkIndex,
            chunkSize: currentChunkSize,
          },
          chunkBuffer
        );

        this.network.sendChunk(transfer.destinationDeviceId, chunkFrame);
      }

      // If window is full or all chunks dispatched, wait for next ACK
      if (session.inFlightChunks.size >= MAX_PIPELINE_WINDOW || session.nextChunkToSend >= transfer.totalChunks) {
        if (session.acknowledgedCount < transfer.totalChunks) {
          await new Promise<void>((resolve) => {
            session.pipelineResolver = resolve;
          });
        }
      }
    }

    if (session.acknowledgedCount >= transfer.totalChunks && !session.cancelled) {
      transfer.status = 'completed';
      transfer.transferred = transfer.size;
      transfer.speed = undefined;
      transfer.eta = undefined;
      transfer.updatedAt = Date.now();
      this.db.saveTransfer(transfer);
      this.emit('transfer_updated', transfer);

      // Send TRANSFER_COMPLETE
      this.network.sendMessage(transfer.destinationDeviceId, {
        type: 'TRANSFER_COMPLETE',
        payload: {
          transferId: transfer.id,
        },
      });

      if (session.isTempFile) {
        try { fs.unlinkSync(session.filePath); } catch {}
      }
      this.outboundSessions.delete(transfer.id);
    }
  }

  private readChunkStream(filePath: string, start: number, end: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (end < start) {
        return resolve(Buffer.alloc(0));
      }
      const chunks: Buffer[] = [];
      const stream = fs.createReadStream(filePath, { start, end, highWaterMark: DEFAULT_CHUNK_SIZE });
      stream.on('data', (data: Buffer | string) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }

  private handleChunkAck(payload: Record<string, any>): void {
    const { transferId, chunkIndex } = payload;
    const session = this.outboundSessions.get(transferId);
    if (!session) return;

    if (session.inFlightChunks.has(chunkIndex)) {
      session.inFlightChunks.delete(chunkIndex);
      session.acknowledgedCount++;

      const now = Date.now();
      session.transfer.transferred = Math.min(session.transfer.size, session.acknowledgedCount * session.transfer.chunkSize);

      const timeDelta = (now - session.lastProgressTime) / 1000;
      if (timeDelta >= 0.25) {
        const bytesDelta = session.transfer.transferred - session.lastTransferredBytes;
        const currentSpeed = Math.round(bytesDelta / timeDelta);
        session.transfer.speed = currentSpeed;
        session.transfer.eta = currentSpeed > 0 ? Math.max(0, Math.ceil((session.transfer.size - session.transfer.transferred) / currentSpeed)) : undefined;
        session.lastProgressTime = now;
        session.lastTransferredBytes = session.transfer.transferred;
      }

      session.transfer.updatedAt = now;
      this.db.saveTransfer(session.transfer);
      this.emit('transfer_updated', session.transfer);

      if (session.pipelineResolver) {
        session.pipelineResolver();
        session.pipelineResolver = null;
      }
    }
  }

  // --- Inbound Transfers (Receiver) ---

  private handleTransferRequest(deviceId: string | null, payload: Record<string, any>): void {
    const { transferId, fileName, fileSize, chunkSize, totalChunks, isFolder, folderName } = payload;

    const sender = deviceId ? this.network.getDevice(deviceId) : null;
    if (!sender || !sender.trusted) {
      if (deviceId) {
        this.network.sendMessage(deviceId, {
          type: 'TRANSFER_REJECT',
          payload: { transferId, reason: 'Device not trusted' },
        });
      }
      return;
    }

    const local = this.network.getLocalInfo();
    const finalPath = getUniqueFilePath(this.downloadDir, fileName);
    const partPath = `${finalPath}.part`;

    const fd = fs.openSync(partPath, 'w+');

    const transfer: Transfer = {
      id: transferId,
      sourceDeviceId: sender.id,
      sourceDeviceName: sender.name,
      destinationDeviceId: local.id,
      destinationDeviceName: local.name,
      fileName: path.basename(finalPath),
      size: fileSize,
      transferred: 0,
      chunkSize: chunkSize || DEFAULT_CHUNK_SIZE,
      totalChunks: totalChunks || 1,
      status: 'transferring',
      isFolder: !!isFolder,
      folderName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db.saveTransfer(transfer);
    this.emit('transfer_updated', transfer);

    this.inboundSessions.set(transferId, {
      transfer,
      partPath,
      finalPath,
      fd,
      completedCount: 0,
      lastProgressTime: Date.now(),
      lastTransferredBytes: 0,
    });

    // Accept transfer
    this.network.sendMessage(sender.id, {
      type: 'TRANSFER_ACCEPT',
      payload: {
        transferId,
        startChunkIndex: 0,
      },
    });
  }

  private handleInboundChunk(deviceId: string | null, chunkMsg: ChunkMessage): void {
    const { header, data } = chunkMsg;
    const session = this.inboundSessions.get(header.transferId);
    if (!session) return;

    // Fast direct write into open file descriptor
    const offset = header.chunkIndex * session.transfer.chunkSize;
    if (data.length > 0) {
      fs.writeSync(session.fd, data, 0, data.length, offset);
    }

    this.db.markChunkCompleted(header.transferId, header.chunkIndex);
    session.completedCount++;
    session.transfer.transferred = Math.min(
      session.transfer.size,
      session.completedCount * session.transfer.chunkSize
    );
    if (session.transfer.size === 0) {
      session.transfer.transferred = 0;
    }

    // High-precision speed & ETA computation over 250ms window
    const now = Date.now();
    const timeDelta = (now - session.lastProgressTime) / 1000;
    if (timeDelta >= 0.25) {
      const bytesDelta = session.transfer.transferred - session.lastTransferredBytes;
      const currentSpeed = Math.round(bytesDelta / timeDelta);
      session.transfer.speed = currentSpeed;
      session.transfer.eta = currentSpeed > 0 ? Math.max(0, Math.ceil((session.transfer.size - session.transfer.transferred) / currentSpeed)) : undefined;
      session.lastProgressTime = now;
      session.lastTransferredBytes = session.transfer.transferred;
    }

    session.transfer.updatedAt = now;
    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    // Send ACK immediately to advance sliding window
    const targetDevId = deviceId || session.transfer.sourceDeviceId;
    this.network.sendMessage(targetDevId, {
      type: 'CHUNK_ACK',
      payload: {
        transferId: header.transferId,
        chunkIndex: header.chunkIndex,
      },
    });
  }

  private async handleRemoteComplete(payload: Record<string, any>): Promise<void> {
    const { transferId } = payload;
    const session = this.inboundSessions.get(transferId);
    if (!session) return;

    try {
      fs.closeSync(session.fd);
    } catch {}

    // Rename .part to final destination
    if (fs.existsSync(session.partPath)) {
      fs.renameSync(session.partPath, session.finalPath);
    }

    // Auto-extract folder if this was an auto-archived folder
    if (session.transfer.isFolder && session.transfer.folderName) {
      try {
        const extractTarget = getUniqueFilePath(this.downloadDir, session.transfer.folderName);
        await extractTarArchive(session.finalPath, extractTarget);
        try { fs.unlinkSync(session.finalPath); } catch {}
        session.transfer.fileName = path.basename(extractTarget);
      } catch (err) {
        console.log(`[WARN] Failed to auto-extract folder: ${(err as Error).message}`);
      }
    }

    session.transfer.status = 'completed';
    session.transfer.transferred = session.transfer.size;
    session.transfer.speed = undefined;
    session.transfer.eta = undefined;
    session.transfer.updatedAt = Date.now();
    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    this.inboundSessions.delete(transferId);
  }

  // --- Controls ---

  public pauseTransfer(transferId: string): void {
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      outSession.paused = true;
      outSession.transfer.status = 'paused';
      outSession.transfer.speed = undefined;
      outSession.transfer.eta = undefined;
      outSession.transfer.updatedAt = Date.now();
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);

      this.network.sendMessage(outSession.transfer.destinationDeviceId, {
        type: 'TRANSFER_PAUSE',
        payload: { transferId },
      });
    }
  }

  public resumeTransfer(transferId: string): void {
    const outSession = this.outboundSessions.get(transferId);
    if (outSession && outSession.paused) {
      outSession.paused = false;
      outSession.transfer.status = 'transferring';
      outSession.lastProgressTime = Date.now();
      outSession.lastTransferredBytes = outSession.transfer.transferred;
      outSession.transfer.updatedAt = Date.now();
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);

      this.network.sendMessage(outSession.transfer.destinationDeviceId, {
        type: 'TRANSFER_RESUME',
        payload: { transferId },
      });

      this.streamOutboundPipelined(outSession);
    }
  }

  public cancelTransfer(transferId: string): void {
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      outSession.cancelled = true;
      outSession.transfer.status = 'cancelled';
      outSession.transfer.speed = undefined;
      outSession.transfer.eta = undefined;
      outSession.transfer.updatedAt = Date.now();
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);

      this.network.sendMessage(outSession.transfer.destinationDeviceId, {
        type: 'TRANSFER_CANCEL',
        payload: { transferId },
      });

      if (outSession.isTempFile) {
        try { fs.unlinkSync(outSession.filePath); } catch {}
      }
      this.outboundSessions.delete(transferId);
    }

    const inSession = this.inboundSessions.get(transferId);
    if (inSession) {
      try { fs.closeSync(inSession.fd); } catch {}
      try { if (fs.existsSync(inSession.partPath)) fs.unlinkSync(inSession.partPath); } catch {}

      inSession.transfer.status = 'cancelled';
      inSession.transfer.speed = undefined;
      inSession.transfer.eta = undefined;
      inSession.transfer.updatedAt = Date.now();
      this.db.saveTransfer(inSession.transfer);
      this.emit('transfer_updated', inSession.transfer);

      this.inboundSessions.delete(transferId);
    }
  }

  private handleRemotePause(payload: Record<string, any>): void {
    const { transferId } = payload;
    const session = this.inboundSessions.get(transferId);
    if (session) {
      session.transfer.status = 'paused';
      session.transfer.speed = undefined;
      session.transfer.eta = undefined;
      this.db.saveTransfer(session.transfer);
      this.emit('transfer_updated', session.transfer);
    }
  }

  private handleRemoteResume(payload: Record<string, any>): void {
    const { transferId } = payload;
    const session = this.inboundSessions.get(transferId);
    if (session) {
      session.transfer.status = 'transferring';
      session.lastProgressTime = Date.now();
      session.lastTransferredBytes = session.transfer.transferred;
      this.db.saveTransfer(session.transfer);
      this.emit('transfer_updated', session.transfer);
    }
  }

  private handleRemoteCancel(payload: Record<string, any>): void {
    const { transferId } = payload;
    const session = this.inboundSessions.get(transferId);
    if (session) {
      try { fs.closeSync(session.fd); } catch {}
      try { if (fs.existsSync(session.partPath)) fs.unlinkSync(session.partPath); } catch {}
      session.transfer.status = 'cancelled';
      session.transfer.speed = undefined;
      session.transfer.eta = undefined;
      this.db.saveTransfer(session.transfer);
      this.emit('transfer_updated', session.transfer);
      this.inboundSessions.delete(transferId);
    }
  }
}
