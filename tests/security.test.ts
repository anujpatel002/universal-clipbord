import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { NetworkManager } from '../src/main/network.js';
import { AppDatabase } from '../src/main/database.js';
import { SecurityManager } from '../src/main/security.js';
import { PairingRequestItem } from '../src/shared/types.js';

describe('Phase 5: Cryptographic Pairing, Challenge-Response Authentication & Trust', () => {
  let dirA: string;
  let dirB: string;
  let dbA: AppDatabase;
  let dbB: AppDatabase;
  let secA: SecurityManager;
  let secB: SecurityManager;
  let nodeA: NetworkManager;
  let nodeB: NetworkManager;
  let portB: number;

  before(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-secA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-secB-'));

    dbA = new AppDatabase(dirA);
    dbB = new AppDatabase(dirB);
    await dbA.init();
    await dbB.init();

    secA = new SecurityManager(dbA);
    secB = new SecurityManager(dbB);

    nodeA = new NetworkManager(dbA, secA);
    nodeB = new NetworkManager(dbB, secB);

    await nodeA.startServer(0);
    portB = await nodeB.startServer(0);

    const infoB = nodeB.getLocalInfo();
    await nodeA.connectToPeer('127.0.0.1', portB, infoB.id);

    // Allow initial HELLO handshake
    await new Promise((r) => setTimeout(r, 100));
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

  test('Ed25519 digital signature creation and verification on nonces', () => {
    const identityA = secA.getIdentity();
    const challenge = secA.createChallenge();
    const signature = secA.sign(challenge);

    const isValid = secB.verify(challenge, signature, identityA.publicKey);
    assert.strictEqual(isValid, true, 'Signature should be valid');

    // Tampered challenge
    const isTamperedValid = secB.verify('tampered-challenge-data', signature, identityA.publicKey);
    assert.strictEqual(isTamperedValid, false, 'Tampered data signature must be invalid');
  });

  test('AES-256-GCM payload encryption and decryption', () => {
    const secretKey = crypto.randomBytes(32);
    const plainText = 'Sensitive clipboard text to protect in transit';

    const encrypted = secA.encrypt(plainText, secretKey);
    assert.notStrictEqual(encrypted.data, plainText);

    const decrypted = secB.decrypt(encrypted, secretKey);
    assert.strictEqual(decrypted, plainText);
  });

  test('Interactive challenge-response pairing handshake', async () => {
    const infoA = nodeA.getLocalInfo();
    const infoB = nodeB.getLocalInfo();

    // Node A initiates pairing with Node B
    const pairRequestPromise = new Promise<PairingRequestItem>((resolve) => {
      nodeB.once('pairing_request', (req: PairingRequestItem) => resolve(req));
    });

    nodeA.sendPairRequest(infoB.id);

    const req = await pairRequestPromise;
    assert.strictEqual(req.deviceId, infoA.id);

    // Node B accepts the pairing request
    nodeB.respondToPairRequest(req.deviceId, true);

    // Give time for PAIR_ACCEPT to process on Node A
    await new Promise((r) => setTimeout(r, 150));

    // Verify both nodes now trust each other
    const devAonB = nodeB.getDevice(infoA.id);
    const devBonA = nodeA.getDevice(infoB.id);

    assert.strictEqual(devAonB?.trusted, true, 'Node B should trust Node A');
    assert.strictEqual(devBonA?.trusted, true, 'Node A should trust Node B');
  });

  test('Unpair / trust revocation', async () => {
    const infoA = nodeA.getLocalInfo();
    const infoB = nodeB.getLocalInfo();

    // Node B revokes trust for Node A
    nodeB.setDeviceTrusted(infoA.id, false);

    const devAonB = nodeB.getDevice(infoA.id);
    assert.strictEqual(devAonB?.trusted, false, 'Trust should be revoked');

    // Now send clipboard update from Node A -> should be ignored because untrusted
    let received = false;
    const msgHandler = ({ deviceId, message }: { deviceId: string | null; message: any }) => {
      if (message.type === 'CLIPBOARD_UPDATE') {
        const sender = deviceId ? nodeB.getDevice(deviceId) : null;
        if (sender && sender.trusted) {
          received = true;
        }
      }
    };
    nodeB.on('message', msgHandler);

    nodeA.sendMessage(infoB.id, {
      type: 'CLIPBOARD_UPDATE',
      payload: {
        id: 'revoked-test-item',
        type: 'text',
        content: 'Should not be accepted',
        sourceDeviceId: infoA.id,
        sourceDeviceName: infoA.name,
        timestamp: Date.now(),
      },
    });

    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(received, false, 'Revoked device must not have clipboard access');
    nodeB.off('message', msgHandler);
  });
});
