import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { NetworkManager } from '../src/main/network.js';
import { AppDatabase } from '../src/main/database.js';
import { SecurityManager } from '../src/main/security.js';

describe('Network & TCP Peer Handshake', () => {
  let dirA: string;
  let dirB: string;
  let dbA: AppDatabase;
  let dbB: AppDatabase;
  let secA: SecurityManager;
  let secB: SecurityManager;
  let nodeA: NetworkManager;
  let nodeB: NetworkManager;
  let portA: number;
  let portB: number;

  before(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-nodeA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-nodeB-'));

    dbA = new AppDatabase(dirA);
    dbB = new AppDatabase(dirB);
    await dbA.init();
    await dbB.init();

    secA = new SecurityManager(dbA);
    secB = new SecurityManager(dbB);

    nodeA = new NetworkManager(dbA, secA);
    nodeB = new NetworkManager(dbB, secB);

    portA = await nodeA.startServer(0);
    portB = await nodeB.startServer(0);
    assert.ok(portA > 0);
    assert.ok(portB > 0);
  });

  after(async () => {
    nodeA.stop();
    nodeB.stop();
    await new Promise((r) => setTimeout(r, 50));
    dbA.close();
    dbB.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  test('Node A and Node B connect, perform HELLO handshake and discover each other', async () => {
    const infoA = nodeA.getLocalInfo();
    const infoB = nodeB.getLocalInfo();

    // Node A initiates connection to Node B
    const peerB = await nodeA.connectToPeer('127.0.0.1', portB, infoB.id);

    assert.strictEqual(peerB.id, infoB.id);
    assert.strictEqual(peerB.status, 'online');

    // Wait a brief moment for Node B's inbound handler to register Node A
    await new Promise((r) => setTimeout(r, 100));

    const nodeBDevices = nodeB.getAllDevices();
    const discoveredA = nodeBDevices.find((d) => d.id === infoA.id);
    assert.ok(discoveredA, 'Node B should have registered Node A');
    assert.strictEqual(discoveredA.status, 'online');
  });

  test('Node A can send a protocol message to Node B', async () => {
    const infoA = nodeA.getLocalInfo();
    const infoB = nodeB.getLocalInfo();

    const receivedPromise = new Promise<{ deviceId: string | null; message: any }>((resolve) => {
      nodeB.once('message', (data) => resolve(data));
    });

    const success = nodeA.sendMessage(infoB.id, {
      type: 'CLIPBOARD_UPDATE',
      payload: {
        id: 'msg-1',
        type: 'text',
        content: 'Hello Peer B from Peer A',
        sourceDeviceId: infoA.id,
        sourceDeviceName: infoA.name,
        timestamp: Date.now(),
      },
    });

    assert.ok(success, 'Message should be sent successfully');

    const received = await receivedPromise;
    assert.strictEqual(received.deviceId, infoA.id);
    assert.strictEqual(received.message.type, 'CLIPBOARD_UPDATE');
    assert.strictEqual(received.message.payload.content, 'Hello Peer B from Peer A');
  });
});
