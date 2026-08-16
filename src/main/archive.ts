import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileEntry {
  fullPath: string;
  relPath: string;
  size: number;
}

/**
 * Robustly calculates recursive directory size and file count without blocking or throwing
 */
export function calculateFolderSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      try {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += calculateFolderSize(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          total += stat.size;
        }
      } catch {
        // Skip inaccessible file
      }
    }
  } catch {
    // Return accumulated count
  }
  return total;
}

/**
 * Asynchronously scans all files in a directory tree with relative paths.
 * Non-blocking and memory-efficient.
 */
export async function scanDirectoryFiles(dirPath: string): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  async function walk(currentDir: string, relPrefix: string): Promise<void> {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.join(relPrefix, entry.name).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          result.push({
            fullPath,
            relPath,
            size: stat.size,
          });
        } catch {
          // Skip inaccessible file
        }
      }
    }
  }

  await walk(dirPath, '');
  return result;
}
