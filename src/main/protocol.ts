import { EventEmitter } from 'node:events';
import { ProtocolMessage } from '../shared/types.js';

export interface ChunkMessage {
  type: 'CHUNK';
  header: {
    transferId: string;
    chunkIndex: number;
    chunkSize: number;
    chunkHash?: string;
  };
  data: Buffer;
}

/**
 * Message Framing Format:
 * [4-byte total payload length (big endian)]
 * [1-byte payload type: 0x01 = JSON ProtocolMessage, 0x02 = Binary CHUNK]
 * If JSON (0x01):
 *   [UTF-8 JSON string]
 * If CHUNK (0x02):
 *   [2-byte header length (big endian)]
 *   [UTF-8 JSON header string]
 *   [Raw binary chunk data]
 */
export const PAYLOAD_TYPE_JSON = 0x01;
export const PAYLOAD_TYPE_CHUNK = 0x02;

export function encodeMessage<T = unknown>(message: ProtocolMessage<T>): Buffer {
  const jsonStr = JSON.stringify(message);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  
  // 4 bytes length + 1 byte type + JSON bytes
  const totalLength = 1 + jsonBuf.length;
  const frame = Buffer.allocUnsafe(4 + totalLength);
  
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt8(PAYLOAD_TYPE_JSON, 4);
  jsonBuf.copy(frame, 5);
  
  return frame;
}

export function encodeChunk(header: { transferId: string; chunkIndex: number; chunkSize: number; chunkHash?: string }, chunkData: Buffer): Buffer {
  const headerStr = JSON.stringify(header);
  const headerBuf = Buffer.from(headerStr, 'utf8');
  
  // 4 bytes length + 1 byte type + 2 bytes header length + header bytes + binary chunk bytes
  const totalLength = 1 + 2 + headerBuf.length + chunkData.length;
  const frame = Buffer.allocUnsafe(4 + totalLength);
  
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt8(PAYLOAD_TYPE_CHUNK, 4);
  frame.writeUInt16BE(headerBuf.length, 5);
  headerBuf.copy(frame, 7);
  chunkData.copy(frame, 7 + headerBuf.length);
  
  return frame;
}

export class MessageFramer extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Push incoming raw TCP data into the framer.
   */
  public push(data: Buffer): void {
    if (this.buffer.length === 0) {
      this.buffer = data;
    } else {
      this.buffer = Buffer.concat([this.buffer, data]);
    }

    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length >= 4) {
      const payloadLength = this.buffer.readUInt32BE(0);

      // Check if we have received the full payload
      if (this.buffer.length < 4 + payloadLength) {
        // Need more data
        break;
      }

      const payload = this.buffer.subarray(4, 4 + payloadLength);
      // Advance buffer
      this.buffer = this.buffer.subarray(4 + payloadLength);

      this.handlePayload(payload);
    }
  }

  private handlePayload(payload: Buffer): void {
    if (payload.length === 0) return;

    const payloadType = payload.readUInt8(0);

    if (payloadType === PAYLOAD_TYPE_JSON) {
      try {
        const jsonStr = payload.subarray(1).toString('utf8');
        const message = JSON.parse(jsonStr) as ProtocolMessage;
        this.emit('message', message);
      } catch (err) {
        this.emit('error', new Error(`Failed to parse JSON message: ${(err as Error).message}`));
      }
    } else if (payloadType === PAYLOAD_TYPE_CHUNK) {
      if (payload.length < 3) {
        this.emit('error', new Error('Malformed CHUNK frame'));
        return;
      }
      const headerLength = payload.readUInt16BE(1);
      if (payload.length < 3 + headerLength) {
        this.emit('error', new Error('Malformed CHUNK frame header'));
        return;
      }

      try {
        const headerStr = payload.subarray(3, 3 + headerLength).toString('utf8');
        const header = JSON.parse(headerStr);
        const chunkData = payload.subarray(3 + headerLength);
        this.emit('chunk', { header, data: chunkData });
      } catch (err) {
        this.emit('error', new Error(`Failed to parse CHUNK frame: ${(err as Error).message}`));
      }
    } else {
      this.emit('error', new Error(`Unknown payload type: 0x${payloadType.toString(16)}`));
    }
  }

  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
