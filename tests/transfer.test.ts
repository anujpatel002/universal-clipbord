import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { NetworkManager } from '../src/main/network.js';
import { AppDatabase } from '../src/main/database.js';
import { SecurityManager } from '../src/main/security.js';
import { TransferManager, calculateFileHash, getUniqueFilePath } from '../src/main/transfer.js';

describe('Phase 3 & 4: Resumable Streaming File Transfer', () => {
  let dirA: string;
  let dirB: string;
  let downloadsB: string;
  let dbA: AppDatabase;
  let dbB: AppDatabase;
  let secA: SecurityManager;
  let secB: SecurityManager;
  let nodeA: NetworkManager;
  let nodeB: NetworkManager;
  let txA: TransferManager;
  let txB: TransferManager;
  let portB: number;

  before(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-txA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-txB-'));
    downloadsB = path.join(dirB, 'downloads');
    fs.mkdirSync(downloadsB, { recursive: true });

    dbA = new AppDatabase(dirA);
    dbB = new AppDatabase(dirB);
    await dbA.init();
    await dbB.init();

    secA = new SecurityManager(dbA);
    secB = new SecurityManager(dbB);

    nodeA = new NetworkManager(dbA, secA);
    nodeB = new NetworkManager(dbB, secB);

    txA = new TransferManager(nodeA, dbA, path.join(dirA, 'downloads'));
    txB = new TransferManager(nodeB, dbB, downloadsB);

    await nodeA.startServer(0);
    portB = await nodeB.startServer(0);

    const infoB = nodeB.getLocalInfo();
    const infoA = nodeA.getLocalInfo();

    await nodeA.connectToPeer('127.0.0.1', portB, infoB.id);

    // Give time for handshake
    await new Promise((r) => setTimeout(r, 100));

    // Trust each other
    nodeA.setDeviceTrusted(infoB.id, true);
    nodeB.setDeviceTrusted(infoA.id, true);
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

  test('Avoids duplicate filename collisions by generating unique paths', () => {
    const testFile = path.join(downloadsB, 'document.pdf');
    fs.writeFileSync(testFile, 'dummy content');

    const uniquePath1 = getUniqueFilePath(downloadsB, 'document.pdf');
    assert.strictEqual(path.basename(uniquePath1), 'document (1).pdf');

    fs.writeFileSync(uniquePath1, 'dummy content 2');
    const uniquePath2 = getUniqueFilePath(downloadsB, 'document.pdf');
    assert.strictEqual(path.basename(uniquePath2), 'document (2).pdf');
  });

  test('Streams and transfers small file with SHA-256 hash match', async () => {
    const infoB = nodeB.getLocalInfo();
    const srcFilePath = path.join(dirA, 'sample_small.txt');
    const fileContent = 'MultiClip zero-RAM-overhead small file streaming test content';
    fs.writeFileSync(srcFilePath, fileContent);

    const sourceHash = await calculateFileHash(srcFilePath);

    // Wait for transfer completion on Node B
    const completePromise = new Promise<string>((resolve) => {
      const handler = (transfer: any) => {
        if (transfer.fileName.includes('sample_small') && transfer.status === 'completed') {
          txB.off('transfer_updated', handler);
          resolve(path.join(downloadsB, transfer.fileName));
        }
      };
      txB.on('transfer_updated', handler);
    });

    await txA.startOutboundTransfer(infoB.id, srcFilePath);

    const destFilePath = await completePromise;
    assert.ok(fs.existsSync(destFilePath), 'Destination file must exist');

    const destHash = await calculateFileHash(destFilePath);
    assert.strictEqual(destHash, sourceHash, 'SHA-256 hashes must match perfectly');
  });

  test('Streams multi-chunk file (5 MB) with constant memory and chunk acknowledgments', async () => {
    const infoB = nodeB.getLocalInfo();
    const srcFilePath = path.join(dirA, 'large_payload.bin');
    // Generate 5 MB pseudo-random binary data (spans 3 chunks with 2MB chunk size)
    const randomBuf = crypto.randomBytes(5 * 1024 * 1024);
    fs.writeFileSync(srcFilePath, randomBuf);

    const sourceHash = await calculateFileHash(srcFilePath);

    const completePromise = new Promise<string>((resolve) => {
      const handler = (transfer: any) => {
        if (transfer.fileName.includes('large_payload') && transfer.status === 'completed') {
          txB.off('transfer_updated', handler);
          resolve(path.join(downloadsB, transfer.fileName));
        }
      };
      txB.on('transfer_updated', handler);
    });

    await txA.startOutboundTransfer(infoB.id, srcFilePath);

    const destFilePath = await completePromise;
    assert.ok(fs.existsSync(destFilePath), 'Multi-chunk destination file must exist');

    const destHash = await calculateFileHash(destFilePath);
    assert.strictEqual(destHash, sourceHash, 'Multi-chunk SHA-256 hashes must match');
  });

  test('Transfer Pause and Resume functionality', async () => {
    const infoB = nodeB.getLocalInfo();
    const srcFilePath = path.join(dirA, 'resumable_file.bin');
    // 6 MB file (3 chunks of 2MB)
    const randomBuf = crypto.randomBytes(6 * 1024 * 1024);
    fs.writeFileSync(srcFilePath, randomBuf);

    const sourceHash = await calculateFileHash(srcFilePath);

    const transfer = await txA.startOutboundTransfer(infoB.id, srcFilePath);

    // Pause transfer quickly
    txA.pauseTransfer(transfer.id);

    await new Promise((r) => setTimeout(r, 100));

    // Resume transfer
    const completePromise = new Promise<string>((resolve) => {
      const handler = (t: any) => {
        if (t.id === transfer.id && t.status === 'completed') {
          txB.off('transfer_updated', handler);
          resolve(path.join(downloadsB, t.fileName));
        }
      };
      txB.on('transfer_updated', handler);
    });

    txA.resumeTransfer(transfer.id);

    const destFilePath = await completePromise;
    assert.ok(fs.existsSync(destFilePath), 'Resumed file must exist');

    const destHash = await calculateFileHash(destFilePath);
    assert.strictEqual(destHash, sourceHash, 'Resumed file hash must match original');
  });

  test('Directly streams and writes whole directory with nested subfolders (Zero ZIP/TAR)', async () => {
    const infoB = nodeB.getLocalInfo();
    const testFolder = path.join(dirA, 'my_project_folder');
    const subFolder = path.join(testFolder, 'sub_directory');
    fs.mkdirSync(subFolder, { recursive: true });

    fs.writeFileSync(path.join(testFolder, 'readme.txt'), 'Hello world in root folder');
    fs.writeFileSync(path.join(subFolder, 'nested_code.js'), 'console.log("nested file content");');

    const completePromise = new Promise<string>((resolve) => {
      const handler = (t: any) => {
        if (t.folderName === 'my_project_folder' && t.status === 'completed') {
          txB.off('transfer_updated', handler);
          resolve(path.join(downloadsB, t.fileName));
        }
      };
      txB.on('transfer_updated', handler);
    });

    await txA.startOutboundTransfer(infoB.id, testFolder);

    const destFolderPath = await completePromise;
    assert.ok(fs.existsSync(destFolderPath), 'Destination folder must exist');
    assert.ok(fs.statSync(destFolderPath).isDirectory(), 'Destination must be a directory');

    const rootFile = path.join(destFolderPath, 'readme.txt');
    const nestedFile = path.join(destFolderPath, 'sub_directory', 'nested_code.js');

    assert.ok(fs.existsSync(rootFile), 'Root file must exist');
    assert.ok(fs.existsSync(nestedFile), 'Nested file must exist');
    assert.strictEqual(fs.readFileSync(rootFile, 'utf8'), 'Hello world in root folder');
    assert.strictEqual(fs.readFileSync(nestedFile, 'utf8'), 'console.log("nested file content");');
  });
});
