import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { MessageFramer, encodeMessage, encodeChunk } from '../src/main/protocol.js';
import { ProtocolMessage } from '../src/shared/types.js';

describe('Protocol Message Framing Layer', () => {
  test('encodes and decodes a single JSON protocol message', (_t, done) => {
    const framer = new MessageFramer();
    const testMessage: ProtocolMessage = {
      type: 'HELLO',
      payload: {
        deviceId: 'node-1',
        deviceName: 'PC-A',
        port: 49152,
        version: '1.0.0',
      },
    };

    framer.on('message', (msg) => {
      assert.deepStrictEqual(msg, testMessage);
      done();
    });

    const encoded = encodeMessage(testMessage);
    framer.push(encoded);
  });

  test('handles fragmented/split packets cleanly', (_t, done) => {
    const framer = new MessageFramer();
    const testMessage: ProtocolMessage = {
      type: 'CLIPBOARD_UPDATE',
      payload: {
        id: 'clip-1',
        type: 'text',
        content: 'Hello World across LAN',
        sourceDeviceId: 'node-1',
        sourceDeviceName: 'PC-A',
        timestamp: 1234567890,
      },
    };

    framer.on('message', (msg) => {
      assert.deepStrictEqual(msg, testMessage);
      done();
    });

    const encoded = encodeMessage(testMessage);
    // Split into 3 arbitrary chunks
    const part1 = encoded.subarray(0, 5);
    const part2 = encoded.subarray(5, 18);
    const part3 = encoded.subarray(18);

    framer.push(part1);
    framer.push(part2);
    framer.push(part3);
  });

  test('encodes and decodes binary CHUNK frame with streaming data', (_t, done) => {
    const framer = new MessageFramer();
    const header = {
      transferId: 'tx-100',
      chunkIndex: 42,
      chunkSize: 1024,
      chunkHash: 'abc123hash',
    };
    const binaryData = Buffer.from('RAW_BINARY_DATA_STREAM_PAYLOAD_FOR_LARGE_FILE');

    framer.on('chunk', ({ header: receivedHeader, data: receivedData }) => {
      assert.deepStrictEqual(receivedHeader, header);
      assert.strictEqual(receivedData.toString(), binaryData.toString());
      done();
    });

    const encoded = encodeChunk(header, binaryData);
    framer.push(encoded);
  });
});
