import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Device, ClipboardItem, Transfer } from '../shared/types.js';

let SQLInstance: SqlJsStatic | null = null;

export class AppDatabase {
  private db: Database | null = null;
  private dbPath: string;
  private isOpen = true;

  constructor(dbDir: string) {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.dbPath = path.join(dbDir, 'multiclip.db');
  }

  public async init(): Promise<void> {
    if (!SQLInstance) {
      SQLInstance = await initSqlJs();
    }
    const buffer = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined;
    this.db = new SQLInstance.Database(buffer);
    this.initSchema();
  }

  private saveToDisk(): void {
    if (!this.db || !this.isOpen) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch {
      // Ignored
    }
  }

  private initSchema(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        trusted INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL,
        public_key TEXT
      );

      CREATE TABLE IF NOT EXISTS clipboard_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT,
        name TEXT,
        size INTEGER,
        source_device_id TEXT NOT NULL,
        source_device_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        source_device_id TEXT NOT NULL,
        source_device_name TEXT NOT NULL,
        destination_device_id TEXT NOT NULL,
        destination_device_name TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        transferred INTEGER NOT NULL DEFAULT 0,
        chunk_size INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS completed_chunks (
        transfer_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        PRIMARY KEY (transfer_id, chunk_index)
      );

      DELETE FROM clipboard_items WHERE name LIKE '%Folder is not supported%';
      DELETE FROM clipboard_items WHERE content LIKE '%Folder is not supported%';
    `);
    this.saveToDisk();
  }

  // Settings
  public getSetting(key: string): string | null {
    if (!this.db || !this.isOpen) return null;
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = :key');
    stmt.bind({ ':key': key });
    if (stmt.step()) {
      const row = stmt.getAsObject() as { value: string };
      stmt.free();
      return row.value;
    }
    stmt.free();
    return null;
  }

  public setSetting(key: string, value: string): void {
    if (!this.db || !this.isOpen) return;
    this.db.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
      [key, value]
    );
    this.saveToDisk();
  }

  // Devices
  public upsertDevice(device: Omit<Device, 'status'>): void {
    if (!this.db || !this.isOpen) return;
    this.db.run(
      `INSERT INTO devices (id, name, ip, port, trusted, last_seen, public_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         ip = excluded.ip,
         port = excluded.port,
         last_seen = excluded.last_seen,
         public_key = COALESCE(excluded.public_key, devices.public_key)`,
      [
        device.id,
        device.name,
        device.ip,
        device.port,
        device.trusted ? 1 : 0,
        device.lastSeen,
        device.publicKey || null,
      ]
    );
    this.saveToDisk();
  }

  public setDeviceTrusted(id: string, trusted: boolean): void {
    if (!this.db || !this.isOpen) return;
    this.db.run('UPDATE devices SET trusted = ? WHERE id = ?', [trusted ? 1 : 0, id]);
    this.saveToDisk();
  }

  public getDevices(): Device[] {
    if (!this.db || !this.isOpen) return [];
    const res = this.db.exec('SELECT * FROM devices ORDER BY last_seen DESC');
    if (!res || res.length === 0) return [];

    const columns = res[0].columns;
    const values = res[0].values;

    return values.map((row) => {
      const obj: Record<string, any> = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return {
        id: obj.id,
        name: obj.name,
        ip: obj.ip,
        port: obj.port,
        trusted: Boolean(obj.trusted),
        lastSeen: obj.last_seen,
        status: 'offline' as const,
        publicKey: obj.public_key || undefined,
      };
    });
  }

  public getDevice(id: string): Device | null {
    if (!this.db || !this.isOpen) return null;
    const stmt = this.db.prepare('SELECT * FROM devices WHERE id = :id');
    stmt.bind({ ':id': id });
    if (stmt.step()) {
      const r = stmt.getAsObject() as {
        id: string;
        name: string;
        ip: string;
        port: number;
        trusted: number;
        last_seen: number;
        public_key: string | null;
      };
      stmt.free();
      return {
        id: r.id,
        name: r.name,
        ip: r.ip,
        port: r.port,
        trusted: Boolean(r.trusted),
        lastSeen: r.last_seen,
        status: 'offline' as const,
        publicKey: r.public_key || undefined,
      };
    }
    stmt.free();
    return null;
  }

  // Clipboard Items
  public addClipboardItem(item: ClipboardItem): void {
    if (!this.db || !this.isOpen) return;
    this.db.run(
      `INSERT OR REPLACE INTO clipboard_items (id, type, content, name, size, source_device_id, source_device_name, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.type,
        item.content || null,
        item.name || null,
        item.size || null,
        item.sourceDeviceId,
        item.sourceDeviceName,
        item.timestamp,
      ]
    );
    this.saveToDisk();
  }

  public getClipboardHistory(limit = 50): ClipboardItem[] {
    if (!this.db || !this.isOpen) return [];
    const stmt = this.db.prepare('SELECT * FROM clipboard_items ORDER BY timestamp DESC LIMIT :limit');
    stmt.bind({ ':limit': limit });
    const items: ClipboardItem[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        id: string;
        type: 'text' | 'image' | 'file';
        content: string | null;
        name: string | null;
        size: number | null;
        source_device_id: string;
        source_device_name: string;
        timestamp: number;
      };
      items.push({
        id: r.id,
        type: r.type,
        content: r.content || undefined,
        name: r.name || undefined,
        size: r.size || undefined,
        sourceDeviceId: r.source_device_id,
        sourceDeviceName: r.source_device_name,
        timestamp: r.timestamp,
      });
    }
    stmt.free();
    return items;
  }

  public clearClipboardHistory(): void {
    if (!this.db || !this.isOpen) return;
    this.db.run('DELETE FROM clipboard_items');
    this.saveToDisk();
  }

  // Transfers
  public saveTransfer(transfer: Transfer): void {
    if (!this.db || !this.isOpen) return;
    this.db.run(
      `INSERT INTO transfers (
        id, source_device_id, source_device_name, destination_device_id, destination_device_name,
        file_name, size, transferred, chunk_size, total_chunks, status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        transferred = excluded.transferred,
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at`,
      [
        transfer.id,
        transfer.sourceDeviceId,
        transfer.sourceDeviceName,
        transfer.destinationDeviceId,
        transfer.destinationDeviceName,
        transfer.fileName,
        transfer.size,
        transfer.transferred,
        transfer.chunkSize,
        transfer.totalChunks,
        transfer.status,
        transfer.error || null,
        transfer.createdAt,
        transfer.updatedAt,
      ]
    );
    this.saveToDisk();
  }

  public getTransfers(): Transfer[] {
    if (!this.db || !this.isOpen) return [];
    const res = this.db.exec('SELECT * FROM transfers ORDER BY created_at DESC');
    if (!res || res.length === 0) return [];

    const columns = res[0].columns;
    const values = res[0].values;

    return values.map((row) => {
      const obj: Record<string, any> = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return {
        id: obj.id,
        sourceDeviceId: obj.source_device_id,
        sourceDeviceName: obj.source_device_name,
        destinationDeviceId: obj.destination_device_id,
        destinationDeviceName: obj.destination_device_name,
        fileName: obj.file_name,
        size: obj.size,
        transferred: obj.transferred,
        chunkSize: obj.chunk_size,
        totalChunks: obj.total_chunks,
        status: obj.status as Transfer['status'],
        error: obj.error || undefined,
        createdAt: obj.created_at,
        updatedAt: obj.updated_at,
      };
    });
  }

  // Chunk resume tracking
  public markChunkCompleted(transferId: string, chunkIndex: number): void {
    if (!this.db || !this.isOpen) return;
    this.db.run(
      `INSERT OR IGNORE INTO completed_chunks (transfer_id, chunk_index) VALUES (?, ?)`,
      [transferId, chunkIndex]
    );
    this.saveToDisk();
  }

  public getCompletedChunks(transferId: string): Set<number> {
    if (!this.db || !this.isOpen) return new Set();
    const stmt = this.db.prepare('SELECT chunk_index FROM completed_chunks WHERE transfer_id = :id');
    stmt.bind({ ':id': transferId });
    const set = new Set<number>();
    while (stmt.step()) {
      const r = stmt.getAsObject() as { chunk_index: number };
      set.add(r.chunk_index);
    }
    stmt.free();
    return set;
  }

  public close(): void {
    if (this.isOpen) {
      this.isOpen = false;
      if (this.db) {
        this.saveToDisk();
        this.db.close();
        this.db = null;
      }
    }
  }
}
