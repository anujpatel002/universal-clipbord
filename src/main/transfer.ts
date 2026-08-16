import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { Transfer, ProtocolMessage, FileStartPayload } from '../shared/types.js';
import { NetworkManager } from './network.js';
import { AppDatabase } from './database.js';
import { encodeChunk, ChunkMessage } from './protocol.js';
import { scanDirectoryFiles, FileEntry } from './archive.js';

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
  sourcePath: string;
  isFolder: boolean;
  fileEntries?: FileEntry[];
  currentFileIndex: number;
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
  targetFolder?: string; // For directory transfers
  partPath?: string;     // For single file transfers
  finalPath: string;
  currentFd?: number;    // Open descriptor for current file being written
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
      case 'FILE_START':
        this.handleFileStart(message.payload as FileStartPayload);
        break;
      case 'FILE_COMPLETE':
        this.handleFileComplete(message.payload as Record<string, any>);
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
      console.log(`[WARN] Peer requested non-existent file/folder: ${filePath}`);
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
      throw new Error(`Path does not exist: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    const isFolder = stats.isDirectory();
    const local = this.network.getLocalInfo();
    const target = this.network.getDevice(targetDeviceId);

    if (!target) {
      throw new Error(`Target device not found: ${targetDeviceId}`);
    }

    const transferId = crypto.randomUUID();
    let totalSize = stats.size;
    let fileEntries: FileEntry[] | undefined;
    const fileName = path.basename(filePath);
    let totalChunks = 0;

    if (isFolder) {
      fileEntries = await scanDirectoryFiles(filePath);
      totalSize = fileEntries.reduce((sum, f) => sum + f.size, 0);
      totalChunks = Math.ceil(totalSize / DEFAULT_CHUNK_SIZE) || 1;
    } else {
      totalChunks = Math.ceil(stats.size / DEFAULT_CHUNK_SIZE) || 1;
    }

    const transfer: Transfer = {
      id: transferId,
      sourceDeviceId: local.id,
      sourceDeviceName: local.name,
      destinationDeviceId: target.id,
      destinationDeviceName: target.name,
      fileName,
      size: totalSize,
      transferred: 0,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks,
      status: 'pending',
      isFolder,
      folderName: isFolder ? fileName : undefined,
      totalFiles: isFolder && fileEntries ? fileEntries.length : 1,
      completedFiles: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db.saveTransfer(transfer);
    this.emit('transfer_updated', transfer);

    this.outboundSessions.set(transferId, {
      transfer,
      sourcePath: filePath,
      isFolder,
      fileEntries,
      currentFileIndex: 0,
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
        fileSize: totalSize,
        chunkSize: DEFAULT_CHUNK_SIZE,
        totalChunks,
        isFolder,
        folderName: isFolder ? fileName : undefined,
        totalFiles: transfer.totalFiles,
      },
    });

    return transfer;
  }

  private handleTransferAccept(payload: Record<string, any>): void {
    const { transferId } = payload;
    const session = this.outboundSessions.get(transferId);
    if (!session) return;

    session.transfer.status = 'transferring';
    session.lastProgressTime = Date.now();
    session.lastTransferredBytes = session.transfer.transferred;

    this.db.saveTransfer(session.transfer);
    this.emit('transfer_updated', session.transfer);

    if (session.isFolder && session.fileEntries) {
      this.streamOutboundDirectory(session);
    } else {
      this.streamOutboundSingleFile(session);
    }
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

  /**
   * Direct Multi-File Directory Streaming:
   * Iterates through files, sends FILE_START, streams chunks with pipelining, sends FILE_COMPLETE.
   * Zero zip/tar archive creation. Zero disk duplication.
   */
  private async streamOutboundDirectory(session: OutboundTransferSession): Promise<void> {
    const { transfer, fileEntries } = session;
    if (!fileEntries) return;

    let globalChunkIndex = 0;

    for (let i = 0; i < fileEntries.length; i++) {
      if (session.cancelled) break;

      const file = fileEntries[i];
      session.transfer.currentFileName = file.relPath;
      this.emit('transfer_updated', session.transfer);

      // 1. Notify receiver of file start
      this.network.sendMessage(transfer.destinationDeviceId, {
        type: 'FILE_START',
        payload: {
          transferId: transfer.id,
          fileIndex: i,
          relPath: file.relPath,
          fileSize: file.size,
        },
      });

      // Handle 0-byte files
      if (file.size === 0) {
        session.transfer.completedFiles = (session.transfer.completedFiles || 0) + 1;
        this.emit('transfer_updated', session.transfer);
        this.network.sendMessage(transfer.destinationDeviceId, {
          type: 'FILE_COMPLETE',
          payload: { transferId: transfer.id, fileIndex: i, relPath: file.relPath },
        });
        continue;
      }

      // Stream file chunks with sliding-window pipelining
      const fileTotalChunks = Math.ceil(file.size / transfer.chunkSize);
      let fileChunkIndex = 0;

      while (fileChunkIndex < fileTotalChunks && !session.paused && !session.cancelled) {
        // Dispatch while window has room
        while (
          session.inFlightChunks.size < MAX_PIPELINE_WINDOW &&
          fileChunkIndex < fileTotalChunks &&
          !session.paused &&
          !session.cancelled
        ) {
          const chunkInFile = fileChunkIndex;
          const currentGlobalChunk = globalChunkIndex;
          fileChunkIndex++;
          globalChunkIndex++;
          session.inFlightChunks.add(currentGlobalChunk);

          const start = chunkInFile * transfer.chunkSize;
          const end = Math.min(start + transfer.chunkSize - 1, file.size - 1);
          const currentChunkSize = end - start + 1;

          const chunkBuffer = await this.readChunkStream(file.fullPath, start, end);

          const chunkFrame = encodeChunk(
            {
              transferId: transfer.id,
              chunkIndex: currentGlobalChunk,
              chunkSize: currentChunkSize,
            },
            chunkBuffer
          );

          this.network.sendChunk(transfer.destinationDeviceId, chunkFrame);
        }

        // Wait for ACK if window is full
        if (session.inFlightChunks.size >= MAX_PIPELINE_WINDOW || fileChunkIndex >= fileTotalChunks) {
          if (session.inFlightChunks.size > 0) {
            await new Promise<void>((resolve) => {
              session.pipelineResolver = resolve;
            });
          }
        }
      }

      // 2. Notify receiver of file complete
      session.transfer.completedFiles = (session.transfer.completedFiles || 0) + 1;
      this.emit('transfer_updated', session.transfer);

      this.network.sendMessage(transfer.destinationDeviceId, {
        type: 'FILE_COMPLETE',
        payload: {
          transferId: transfer.id,
          fileIndex: i,
          relPath: file.relPath,
        },
      });

      // Yield event loop briefly to keep UI at 60 FPS
      await new Promise((r) => setImmediate(r));
    }

    if (!session.cancelled) {
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
        payload: { transferId: transfer.id },
      });

      this.outboundSessions.delete(transfer.id);
    }
  }

  /**
   * Direct Single File Streaming:
   * Streams chunks directly from disk with sliding-window pipelining.
   */
  private async streamOutboundSingleFile(session: OutboundTransferSession): Promise<void> {
    const { transfer, sourcePath } = session;
    let nextChunk = 0;

    while (session.acknowledgedCount < transfer.totalChunks && !session.paused && !session.cancelled) {
      while (
        session.inFlightChunks.size < MAX_PIPELINE_WINDOW &&
        nextChunk < transfer.totalChunks &&
        !session.paused &&
        !session.cancelled
      ) {
        const chunkIndex = nextChunk;
        nextChunk++;
        session.inFlightChunks.add(chunkIndex);

        const start = chunkIndex * transfer.chunkSize;
        const end = Math.min(start + transfer.chunkSize - 1, transfer.size - 1);
        const currentChunkSize = transfer.size === 0 ? 0 : end - start + 1;

        const chunkBuffer = await this.readChunkStream(sourcePath, start, end);

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

      if (session.inFlightChunks.size >= MAX_PIPELINE_WINDOW || nextChunk >= transfer.totalChunks) {
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

      this.network.sendMessage(transfer.destinationDeviceId, {
        type: 'TRANSFER_COMPLETE',
        payload: { transferId: transfer.id },
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
    const { transferId, fileName, fileSize, chunkSize, totalChunks, isFolder, folderName, totalFiles } = payload;

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
    let finalPath = '';
    let targetFolder: string | undefined;
    let partPath: string | undefined;
    let currentFd: number | undefined;

    if (isFolder) {
      // Direct directory creation
      targetFolder = getUniqueFilePath(this.downloadDir, folderName || fileName);
      fs.mkdirSync(targetFolder, { recursive: true });
      finalPath = targetFolder;
    } else {
      finalPath = getUniqueFilePath(this.downloadDir, fileName);
      partPath = `${finalPath}.part`;
      currentFd = fs.openSync(partPath, 'w+');
    }

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
      folderName: isFolder ? path.basename(finalPath) : undefined,
      totalFiles: totalFiles || (isFolder ? 1 : 1),
      completedFiles: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db.saveTransfer(transfer);
    this.emit('transfer_updated', transfer);

    this.inboundSessions.set(transferId, {
      transfer,
      targetFolder,
      partPath,
      finalPath,
      currentFd,
      completedCount: 0,
      lastProgressTime: Date.now(),
      lastTransferredBytes: 0,
    });

    // Accept transfer
    this.network.sendMessage(sender.id, {
      type: 'TRANSFER_ACCEPT',
      payload: { transferId },
    });
  }

  private handleFileStart(payload: FileStartPayload): void {
    const { transferId, relPath } = payload;
    const session = this.inboundSessions.get(transferId);
    if (!session || !session.targetFolder) return;

    // Close previous descriptor if open
    if (session.currentFd !== undefined) {
      try { fs.closeSync(session.currentFd); } catch {}
      session.currentFd = undefined;
    }

    const destFilePath = path.join(session.targetFolder, relPath);
    fs.mkdirSync(path.dirname(destFilePath), { recursive: true });

    session.currentFd = fs.openSync(destFilePath, 'w+');
    session.transfer.currentFileName = relPath;
    this.emit('transfer_updated', session.transfer);
  }

  private handleFileComplete(payload: Record<string, any>): void {
    const { transferId } = payload;
    const session = this.inboundSessions.get(transferId);
    if (!session) return;

    if (session.currentFd !== undefined) {
      try { fs.closeSync(session.currentFd); } catch {}
      session.currentFd = undefined;
    }

    session.transfer.completedFiles = (session.transfer.completedFiles || 0) + 1;
    this.emit('transfer_updated', session.transfer);
  }

  private handleInboundChunk(deviceId: string | null, chunkMsg: ChunkMessage): void {
    const { header, data } = chunkMsg;
    const session = this.inboundSessions.get(header.transferId);
    if (!session) return;

    // Direct write into current open file descriptor (whether single file or inside folder)
    if (session.currentFd !== undefined && data.length > 0) {
      // In folder transfer, chunks are written sequentially to the current file
      fs.writeSync(session.currentFd, data);
    }

    this.db.markChunkCompleted(header.transferId, header.chunkIndex);
    session.completedCount++;
    session.transfer.transferred = Math.min(
      session.transfer.size,
      session.transfer.transferred + data.length
    );

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

  private async handleRemoteComplete(payload: Record<string, any>): Promise<void> {
    const { transferId } = payload;
    const session = this.inboundSessions.get(transferId);
    if (!session) return;

    // Close descriptor
    if (session.currentFd !== undefined) {
      try { fs.closeSync(session.currentFd); } catch {}
      session.currentFd = undefined;
    }

    // If single file, rename .part to final
    if (session.partPath && fs.existsSync(session.partPath)) {
      fs.renameSync(session.partPath, session.finalPath);
    }

    session.transfer.status = 'completed';
    session.transfer.transferred = session.transfer.size;
    session.transfer.speed = undefined;
    session.transfer.eta = undefined;
    session.transfer.currentFileName = undefined;
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

      if (outSession.isFolder) {
        this.streamOutboundDirectory(outSession);
      } else {
        this.streamOutboundSingleFile(outSession);
      }
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

      this.outboundSessions.delete(transferId);
    }

    const inSession = this.inboundSessions.get(transferId);
    if (inSession) {
      if (inSession.currentFd !== undefined) {
        try { fs.closeSync(inSession.currentFd); } catch {}
      }
      try {
        if (inSession.partPath && fs.existsSync(inSession.partPath)) {
          fs.unlinkSync(inSession.partPath);
        }
      } catch {}

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
      if (session.currentFd !== undefined) {
        try { fs.closeSync(session.currentFd); } catch {}
      }
      try {
        if (session.partPath && fs.existsSync(session.partPath)) {
          fs.unlinkSync(session.partPath);
        }
      } catch {}
      session.transfer.status = 'cancelled';
      session.transfer.speed = undefined;
      session.transfer.eta = undefined;
      this.db.saveTransfer(session.transfer);
      this.emit('transfer_updated', session.transfer);
      this.inboundSessions.delete(transferId);
    }
  }
}
