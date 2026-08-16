import { clipboard } from 'electron';
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClipboardItem } from '../shared/types.js';
import { NetworkManager } from './network.js';
import { AppDatabase } from './database.js';

export class ClipboardMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private lastText: string = '';
  private lastFilePath: string = '';
  private suppressedTexts: Set<string> = new Set();

  constructor(
    private network: NetworkManager,
    private db: AppDatabase
  ) {
    super();
  }

  public start(intervalMs = 250): void {
    // Initial check
    this.checkClipboard();

    this.timer = setInterval(() => {
      this.checkClipboard();
    }, intervalMs);
  }

  public checkClipboard(): void {
    try {
      if (!clipboard) return;

      // 1. Check for file path in native clipboard buffers (e.g. Windows FileNameW)
      const detectedFilePath = this.detectCopiedFilePath();
      if (detectedFilePath && detectedFilePath !== this.lastFilePath) {
        if (!this.suppressedTexts.has(detectedFilePath)) {
          this.lastFilePath = detectedFilePath;
          const item = this.createLocalFileItem(detectedFilePath);
          if (item) {
            this.emit('clipboard_updated', item);
            return;
          }
        }
      }

      // 2. Check for text
      if (typeof clipboard.readText !== 'function') return;
      const currentText = clipboard.readText();
      if (!currentText || currentText === this.lastText) {
        return;
      }

      this.lastText = currentText;

      // Check if text is actually a local file path copied via path string
      if (fs.existsSync(currentText.trim())) {
        try {
          const stats = fs.statSync(currentText.trim());
          if (stats.isFile() || stats.isDirectory()) {
            if (!this.suppressedTexts.has(currentText.trim())) {
              const item = this.createLocalFileItem(currentText.trim());
              if (item) {
                this.emit('clipboard_updated', item);
                return;
              }
            }
          }
        } catch {
          // Continue as plain text
        }
      }

      // Check suppression
      if (this.suppressedTexts.has(currentText)) {
        this.suppressedTexts.delete(currentText);
        return;
      }

      const item = this.createLocalTextItem(currentText);
      this.emit('clipboard_updated', item);
    } catch (err) {
      console.log(`[WARN] Clipboard check error: ${(err as Error).message}`);
    }
  }

  private detectCopiedFilePath(): string | null {
    try {
      if (typeof clipboard.readBuffer !== 'function') return null;

      // Windows Explorer File Copy format: FileNameW (UTF-16LE null-terminated)
      if (process.platform === 'win32') {
        const buf = clipboard.readBuffer('FileNameW');
        if (buf && buf.length > 0) {
          const rawStr = buf.toString('utf16le');
          const filePath = rawStr.split('\0')[0].trim();
          if (filePath && fs.existsSync(filePath)) {
            return filePath;
          }
        }
      }

      // Linux / macOS text/uri-list
      const uriBuf = clipboard.readBuffer('text/uri-list');
      if (uriBuf && uriBuf.length > 0) {
        const uriStr = uriBuf.toString('utf8').trim();
        const filePath = uriStr.replace(/^file:\/\//, '').split('\r\n')[0];
        if (filePath && fs.existsSync(filePath)) {
          return filePath;
        }
      }
    } catch {
      // Ignored
    }
    return null;
  }

  public createLocalFileItem(filePath: string): ClipboardItem | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stats = fs.statSync(filePath);
      const local = this.network.getLocalInfo();

      const item: ClipboardItem = {
        id: crypto.randomUUID(),
        type: 'file',
        name: path.basename(filePath),
        size: stats.size,
        path: filePath,
        sourceDeviceId: local.id,
        sourceDeviceName: local.name,
        timestamp: Date.now(),
      };

      this.db.addClipboardItem(item);
      return item;
    } catch {
      return null;
    }
  }

  public createLocalTextItem(text: string): ClipboardItem {
    const local = this.network.getLocalInfo();
    const item: ClipboardItem = {
      id: crypto.randomUUID(),
      type: 'text',
      content: text,
      sourceDeviceId: local.id,
      sourceDeviceName: local.name,
      timestamp: Date.now(),
    };

    this.lastText = text;
    this.db.addClipboardItem(item);
    return item;
  }

  public setClipboardText(text: string, skipBroadcast = true): void {
    if (skipBroadcast) {
      this.suppressedTexts.add(text);
      setTimeout(() => this.suppressedTexts.delete(text), 5000);
    }
    this.lastText = text;
    try {
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(text);
      }
    } catch {
      // Headless/test fallback
    }
  }

  /**
   * Writes a file to the native OS clipboard so pressing Ctrl+V in Windows Explorer
   * pastes the actual file, and in text editors pastes the file path.
   */
  public setClipboardFile(filePath: string, skipBroadcast = true): void {
    if (!fs.existsSync(filePath)) return;
    if (skipBroadcast) {
      this.lastFilePath = filePath;
      this.suppressedTexts.add(filePath);
      setTimeout(() => this.suppressedTexts.delete(filePath), 5000);
    }
    this.lastText = filePath;

    try {
      if (!clipboard) return;

      // 1. Text representation for code editors, browsers, terminals
      if (typeof clipboard.writeText === 'function') {
        clipboard.writeText(filePath);
      }

      // 2. Windows Explorer HDROP / FileNameW format for native file paste
      if (process.platform === 'win32' && typeof clipboard.writeBuffer === 'function') {
        const fileBuf = Buffer.from(filePath + '\0\0', 'utf16le');
        clipboard.writeBuffer('FileNameW', fileBuf);

        // Standard Windows DROPFILES structure:
        // DWORD pFiles (offset 20) | POINT pt (0,0) | BOOL fNC (0) | BOOL fWide (1 = Unicode)
        const header = Buffer.alloc(20);
        header.writeUInt32LE(20, 0); // pFiles offset
        header.writeUInt32LE(0, 4);  // pt.x
        header.writeUInt32LE(0, 8);  // pt.y
        header.writeUInt32LE(0, 12); // fNC
        header.writeUInt32LE(1, 16); // fWide = 1 (Unicode)
        const dropFilesBuf = Buffer.concat([header, fileBuf]);
        clipboard.writeBuffer('HDROP', dropFilesBuf);
      }
    } catch (err) {
      console.log(`[WARN] Failed to write file to OS clipboard: ${(err as Error).message}`);
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.suppressedTexts.clear();
  }
}
