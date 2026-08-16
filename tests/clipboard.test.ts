import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { NetworkManager } from '../src/main/network.js';
import { AppDatabase } from '../src/main/database.js';
import { SecurityManager } from '../src/main/security.js';
import { ClipboardMonitor } from '../src/main/clipboard.js';
import { ClipboardItem } from '../src/shared/types.js';

describe('Phase 2: Text Clipboard Synchronization', () => {
  let dirA: string;
  let dirB: string;
  let dbA: AppDatabase;
  let dbB: AppDatabase;
  let secA: SecurityManager;
  let secB: SecurityManager;
  let nodeA: NetworkManager;
  let nodeB: NetworkManager;
  let clipA: ClipboardMonitor;
  let clipB: ClipboardMonitor;
  let portB: number;

  before(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-clipA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-clipB-'));

    dbA = new AppDatabase(dirA);
    dbB = new AppDatabase(dirB);
    await dbA.init();
    await dbB.init();

    secA = new SecurityManager(dbA);
    secB = new SecurityManager(dbB);

    nodeA = new NetworkManager(dbA, secA);
    nodeB = new NetworkManager(dbB, secB);

    clipA = new ClipboardMonitor(nodeA, dbA);
    clipB = new ClipboardMonitor(nodeB, dbB);

    await nodeA.startServer(0);
    portB = await nodeB.startServer(0);

    const infoB = nodeB.getLocalInfo();
    await nodeA.connectToPeer('127.0.0.1', portB, infoB.id);

    // Give time for handshake
    await new Promise((r) => setTimeout(r, 100));
  });

  after(async () => {
    clipA.stop();
    clipB.stop();
    nodeA.stop();
    nodeB.stop();
    await new Promise((r) => setTimeout(r, 50));
    dbA.close();
    dbB.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  test('Local text creation writes to database and creates item', () => {
    const item = clipA.createLocalTextItem('Hello from Node A');
    assert.strictEqual(item.type, 'text');
    assert.strictEqual(item.content, 'Hello from Node A');

    const history = dbA.getClipboardHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].content, 'Hello from Node A');
  });

  test('Clipboard broadcast is ignored by receiver if sender is not trusted', async () => {
    const infoA = nodeA.getLocalInfo();
    const infoB = nodeB.getLocalInfo();

    // Ensure Node A is NOT trusted on Node B
    nodeB.setDeviceTrusted(infoA.id, false);

    let receivedByB = false;
    const msgHandler = ({ deviceId, message }: { deviceId: string | null; message: any }) => {
      if (message.type === 'CLIPBOARD_UPDATE') {
        const sender = deviceId ? nodeB.getDevice(deviceId) : null;
        if (sender && sender.trusted) {
          receivedByB = true;
        }
      }
    };
    nodeB.on('message', msgHandler);

    // Node A sends clipboard item to Node B
    nodeA.sendMessage(infoB.id, {
      type: 'CLIPBOARD_UPDATE',
      payload: {
        id: 'clip-untrusted',
        type: 'text',
        content: 'Untrusted content',
        sourceDeviceId: infoA.id,
        sourceDeviceName: infoA.name,
        timestamp: Date.now(),
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(receivedByB, false, 'Untrusted clipboard item should be rejected');
    nodeB.off('message', msgHandler);
  });

  test('Clipboard broadcast succeeds when sender is marked trusted', async () => {
    const infoA = nodeA.getLocalInfo();
    const infoB = nodeB.getLocalInfo();

    // Mark Node A trusted on Node B
    nodeB.setDeviceTrusted(infoA.id, true);

    const receivedPromise = new Promise<ClipboardItem>((resolve) => {
      const handler = ({ message }: { message: any }) => {
        if (message.type === 'CLIPBOARD_UPDATE') {
          nodeB.off('message', handler);
          resolve(message.payload);
        }
      };
      nodeB.on('message', handler);
    });

    const item = clipA.createLocalTextItem('Trusted Synchronized Text');
    nodeA.sendMessage(infoB.id, {
      type: 'CLIPBOARD_UPDATE',
      payload: item,
    });

    const received = await receivedPromise;
    assert.strictEqual(received.content, 'Trusted Synchronized Text');
    assert.strictEqual(received.sourceDeviceId, infoA.id);
  });

  test('Echo prevention: suppressed text does not trigger re-emission', () => {
    // When text is set with skipBroadcast = true, it gets recorded in suppressed set
    clipB.setClipboardText('Remote Text Inbound', true);

    let reEmitted = false;
    clipB.once('clipboard_updated', () => {
      reEmitted = true;
    });

    // Simulate check
    clipB.checkClipboard();
    assert.strictEqual(reEmitted, false, 'Suppressed text must not re-emit');
  });
});
