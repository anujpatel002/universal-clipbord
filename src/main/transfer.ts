import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { Transfer, ProtocolMessage } from '../shared/types.js';
import { NetworkManager } from './network.js';
import { AppDatabase } from './database.js';
import { encodeChunk, ChunkMessage } from './protocol.js';

export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunks

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
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

interface OutboundTransferSession {
  transfer: Transfer;
  filePath: string;
  currentChunk: number;
  paused: boolean;
  cancelled: boolean;
  ackResolver: (() => void) | null;
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
    this.network.on('message', ({ deviceId, message }: { deviceId: string | null; message: ProtocolMessage }) => {
      this.handleProtocolMessage(deviceId, message);
    });

    this.network.on('chunk', ({ deviceId, chunk }: { deviceId: string | null; chunk: ChunkMessage }) => {
      this.handleInboundChunk(deviceId, chunk);
    });
  }

  private handleProtocolMessage(deviceId: string | null, message: ProtocolMessage): void {
    const payload = message.payload as Record<string, any>;

    switch (message.type) {
      case 'TRANSFER_REQUEST':
        this.handleTransferRequest(deviceId, payload);
        break;
      case 'TRANSFER_ACCEPT':
        this.handleTransferAccept(payload);
        break;
      case 'TRANSFER_REJECT':
        this.handleTransferReject(payload);
        break;
      case 'CHUNK_ACK':
        this.handleChunkAck(payload);
        break;
      case 'TRANSFER_PAUSE':
        this.handleRemotePause(payload);
        break;
      case 'TRANSFER_RESUME':
        this.handleRemoteResume(payload);
        break;
      case 'TRANSFER_CANCEL':
        this.handleRemoteCancel(payload);
        break;
      case 'TRANSFER_COMPLETE':
        this.handleRemoteComplete(payload);
        break;
      case 'REQUEST_FILE':
        this.handleIncomingFileRequest(deviceId, payload);
        break;
    }
  }

  public requestFileFromPeer(sourceDeviceId: string, remoteFilePath: string): void {
    this.network.sendMessage(sourceDeviceId, {
      type: 'REQUEST_FILE',
      payload: { filePath: remoteFilePath },
    });
  }

  private handleIncomingFileRequest(deviceId: string | null, payload: Record<string, any>): void {
    if (!deviceId) return;
    const sender = this.network.getDevice(deviceId);
    if (!sender || !sender.trusted) return;

    const { filePath } = payload;
    if (filePath && fs.existsSync(filePath)) {
      this.startOutboundTransfer(deviceId, filePath).catch((err) => {
        console.log(`[WARN] Failed to start requested transfer for ${filePath}: ${err.message}`);
      });
    }
  }

  // --- Outbound Transfers ---

  public async startOutboundTransfer(targetDeviceId: string, filePath: string): Promise<Transfer> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const local = this.network.getLocalInfo();
    const target = this.network.getDevice(targetDeviceId);

    if (!target) {
      throw new Error(`Target device not found: ${targetDeviceId}`);
    }

    const totalChunks = Math.ceil(stats.size / DEFAULT_CHUNK_SIZE) || 1;
    const transferId = crypto.randomUUID();

    const transfer: Transfer = {
      id: transferId,
      sourceDeviceId: local.id,
      sourceDeviceName: local.name,
      destinationDeviceId: target.id,
      destinationDeviceName: target.name,
      fileName,
      size: stats.size,
      transferred: 0,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db.saveTransfer(transfer);
    this.emit('transfer_updated', transfer);

    this.outboundSessions.set(transferId, {
      transfer,
      filePath,
      currentChunk: 0,
      paused: false,
      cancelled: false,
      ackResolver: null,
    });

    // Send TRANSFER_REQUEST
    this.network.sendMessage(targetDeviceId, {
      type: 'TRANSFER_REQUEST',
      payload: {
        transferId,
        fileName,
        fileSize: stats.size,
        chunkSize: DEFAULT_CHUNK_SIZE,
        totalChunks,
      },
    });

    return transfer;
  }

  private handleTransferAccept(payload: Record<string, any>): void {
    const { transferId, startChunkIndex } = payload;
    const session = this.outboundSessions.get(transferId);
    if (!session) return;

    session.transfer.status = 'transferring';
    session.currentChunk = typeof startChunkIndex === 'number' ? startChunkIndex : 0;
    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    this.streamOutboundChunks(session);
  }

  private handleTransferReject(payload: Record<string, any>): void {
    const { transferId, reason } = payload;
    const session = this.outboundSessions.get(transferId);
    if (!session) return;

    session.transfer.status = 'cancelled';
    session.transfer.error = reason || 'Transfer rejected by peer';
    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);
    this.outboundSessions.delete(transferId);
  }

  private async streamOutboundChunks(session: OutboundTransferSession): Promise<void> {
    const { transfer, filePath } = session;

    while (session.currentChunk < transfer.totalChunks && !session.paused && !session.cancelled) {
      const chunkIndex = session.currentChunk;
      const start = chunkIndex * transfer.chunkSize;
      const end = Math.min(start + transfer.chunkSize - 1, transfer.size - 1);
      const currentChunkSize = transfer.size === 0 ? 0 : end - start + 1;

      // Stream read single chunk using fs.createReadStream (never load entire file into memory)
      const chunkBuffer = await this.readChunkStream(filePath, start, end);

      const chunkFrame = encodeChunk(
        {
          transferId: transfer.id,
          chunkIndex,
          chunkSize: currentChunkSize,
        },
        chunkBuffer
      );

      // Create backpressure promise for CHUNK_ACK
      const ackPromise = new Promise<void>((resolve) => {
        session.ackResolver = resolve;
      });

      // Send binary chunk frame directly
      this.network.sendChunk(transfer.destinationDeviceId, chunkFrame);

      // Await receiver ACK before sending next chunk
      await ackPromise;

      transfer.transferred = Math.min(transfer.size, (chunkIndex + 1) * transfer.chunkSize);
      transfer.updatedAt = Date.now();
      this.db.saveTransfer(transfer);
      this.emit('transfer_updated', transfer);

      session.currentChunk++;
    }

    if (session.currentChunk >= transfer.totalChunks && !session.cancelled) {
      transfer.status = 'completed';
      transfer.transferred = transfer.size;
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

      this.outboundSessions.delete(transfer.id);
    }
  }

  private readChunkStream(filePath: string, start: number, end: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (end < start) {
        return resolve(Buffer.alloc(0));
      }
      const chunks: Buffer[] = [];
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('data', (data: Buffer | string) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }

  private handleChunkAck(payload: Record<string, any>): void {
    const { transferId } = payload;
    const session = this.outboundSessions.get(transferId);
    if (session && session.ackResolver) {
      session.ackResolver();
      session.ackResolver = null;
    }
  }

  // --- Inbound Transfers ---

  private handleTransferRequest(deviceId: string | null, payload: Record<string, any>): void {
    const { transferId, fileName, fileSize, chunkSize, totalChunks } = payload;

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

    // Open .part file for random-access chunk writing
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

    // Write chunk at exact byte position (random access streaming write)
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

    // Calculate speed
    const now = Date.now();
    const timeDelta = (now - session.lastProgressTime) / 1000;
    if (timeDelta >= 0.5) {
      const bytesDelta = session.transfer.transferred - session.lastTransferredBytes;
      session.transfer.speed = Math.round(bytesDelta / timeDelta);
      session.lastProgressTime = now;
      session.lastTransferredBytes = session.transfer.transferred;
    }

    session.transfer.updatedAt = now;
    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    // Send ACK back to sender
    const targetDevId = deviceId || session.transfer.sourceDeviceId;
    this.network.sendMessage(targetDevId, {
      type: 'CHUNK_ACK',
      payload: {
        transferId: header.transferId,
        chunkIndex: header.chunkIndex,
      },
    });
  }

  private handleRemoteComplete(payload: Record<string, any>): void {
    const { transferId } = payload;
    const session = this.inboundSessions.get(transferId);
    if (!session) return;

    try {
      fs.closeSync(session.fd);
    } catch {
      // Already closed
    }

    // Rename .part to final destination
    if (fs.existsSync(session.partPath)) {
      fs.renameSync(session.partPath, session.finalPath);
    }

    session.transfer.status = 'completed';
    session.transfer.transferred = session.transfer.size;
    session.transfer.updatedAt = Date.now();
    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    this.inboundSessions.delete(transferId);
  }

  // --- Pause / Resume / Cancel Controls ---

  public pauseTransfer(transferId: string): void {
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      outSession.paused = true;
      outSession.transfer.status = 'paused';
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);
      this.network.sendMessage(outSession.transfer.destinationDeviceId, {
        type: 'TRANSFER_PAUSE',
        payload: { transferId },
      });
      return;
    }

    const inSession = this.inboundSessions.get(transferId);
    if (inSession) {
      inSession.transfer.status = 'paused';
      this.db.saveTransfer(inSession.transfer);
      this.emit('transfer_updated', inSession.transfer);
      this.network.sendMessage(inSession.transfer.sourceDeviceId, {
        type: 'TRANSFER_PAUSE',
        payload: { transferId },
      });
    }
  }

  public resumeTransfer(transferId: string): void {
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      outSession.paused = false;
      outSession.transfer.status = 'transferring';
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);
      this.network.sendMessage(outSession.transfer.destinationDeviceId, {
        type: 'TRANSFER_RESUME',
        payload: { transferId, fromChunkIndex: outSession.currentChunk },
      });
      this.streamOutboundChunks(outSession);
      return;
    }

    const inSession = this.inboundSessions.get(transferId);
    if (inSession) {
      inSession.transfer.status = 'transferring';
      this.db.saveTransfer(inSession.transfer);
      this.emit('transfer_updated', inSession.transfer);
      this.network.sendMessage(inSession.transfer.sourceDeviceId, {
        type: 'TRANSFER_RESUME',
        payload: { transferId },
      });
    }
  }

  public cancelTransfer(transferId: string): void {
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      outSession.cancelled = true;
      outSession.transfer.status = 'cancelled';
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);
      this.network.sendMessage(outSession.transfer.destinationDeviceId, {
        type: 'TRANSFER_CANCEL',
        payload: { transferId, reason: 'Cancelled by user' },
      });
      this.outboundSessions.delete(transferId);
      return;
    }

    const inSession = this.inboundSessions.get(transferId);
    if (inSession) {
      try {
        fs.closeSync(inSession.fd);
        if (fs.existsSync(inSession.partPath)) {
          fs.unlinkSync(inSession.partPath);
        }
      } catch {
        // cleanup
      }

      inSession.transfer.status = 'cancelled';
      this.db.saveTransfer(inSession.transfer);
      this.emit('transfer_updated', inSession.transfer);
      this.network.sendMessage(inSession.transfer.sourceDeviceId, {
        type: 'TRANSFER_CANCEL',
        payload: { transferId, reason: 'Cancelled by user' },
      });
      this.inboundSessions.delete(transferId);
    }
  }

  private handleRemotePause(payload: Record<string, any>): void {
    const { transferId } = payload;
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      outSession.paused = true;
      outSession.transfer.status = 'paused';
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);
    }
  }

  private handleRemoteResume(payload: Record<string, any>): void {
    const { transferId, fromChunkIndex } = payload;
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      if (typeof fromChunkIndex === 'number') {
        outSession.currentChunk = fromChunkIndex;
      }
      outSession.paused = false;
      outSession.transfer.status = 'transferring';
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);
      this.streamOutboundChunks(outSession);
    }
  }

  private handleRemoteCancel(payload: Record<string, any>): void {
    const { transferId, reason } = payload;
    const outSession = this.outboundSessions.get(transferId);
    if (outSession) {
      outSession.cancelled = true;
      outSession.transfer.status = 'cancelled';
      outSession.transfer.error = reason;
      this.db.saveTransfer(outSession.transfer);
      this.emit('transfer_updated', outSession.transfer);
      this.outboundSessions.delete(transferId);
    }

    const inSession = this.inboundSessions.get(transferId);
    if (inSession) {
      try {
        fs.closeSync(inSession.fd);
        if (fs.existsSync(inSession.partPath)) {
          fs.unlinkSync(inSession.partPath);
        }
      } catch {
        // cleanup
      }
      inSession.transfer.status = 'cancelled';
      inSession.transfer.error = reason;
      this.db.saveTransfer(inSession.transfer);
      this.emit('transfer_updated', inSession.transfer);
      this.inboundSessions.delete(transferId);
    }
  }
}
