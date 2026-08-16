import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AppDatabase } from '../src/main/database.js';

describe('AppDatabase (SQLite)', () => {
  let db: AppDatabase;
  let tempDir: string;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiclip-test-'));
    db = new AppDatabase(tempDir);
    await db.init();
  });

  after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('saves and retrieves settings', () => {
    db.setSetting('test_key', 'test_val');
    assert.strictEqual(db.getSetting('test_key'), 'test_val');
    assert.strictEqual(db.getSetting('non_existent'), null);
  });

  test('upserts and retrieves discovered devices', () => {
    db.upsertDevice({
      id: 'dev-1',
      name: 'Laptop-1',
      ip: '192.168.1.50',
      port: 49152,
      trusted: false,
      lastSeen: Date.now(),
    });

    const devices = db.getDevices();
    assert.strictEqual(devices.length, 1);
    assert.strictEqual(devices[0].id, 'dev-1');
    assert.strictEqual(devices[0].name, 'Laptop-1');
    assert.strictEqual(devices[0].trusted, false);

    // Update to trusted
    db.setDeviceTrusted('dev-1', true);
    const updated = db.getDevice('dev-1');
    assert.strictEqual(updated?.trusted, true);
  });

  test('records and retrieves clipboard items', () => {
    db.addClipboardItem({
      id: 'clip-1',
      type: 'text',
      content: 'Hello Clipboard',
      sourceDeviceId: 'dev-1',
      sourceDeviceName: 'Laptop-1',
      timestamp: Date.now(),
    });

    const history = db.getClipboardHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].content, 'Hello Clipboard');
  });

  test('tracks completed chunks for large file resume', () => {
    db.markChunkCompleted('tx-1', 0);
    db.markChunkCompleted('tx-1', 1);
    db.markChunkCompleted('tx-1', 5);

    const completed = db.getCompletedChunks('tx-1');
    assert.strictEqual(completed.size, 3);
    assert.ok(completed.has(0));
    assert.ok(completed.has(1));
    assert.ok(completed.has(5));
    assert.ok(!completed.has(2));
  });
});
