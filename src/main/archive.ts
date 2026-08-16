import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Robustly calculates recursive directory size without throwing on inaccessible files
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
        // Skip individual locked or unreadable files
      }
    }
  } catch {
    // Return accumulated count
  }
  return total;
}

/**
 * Creates a standard 512-byte POSIX USTAR header
 */
function createTarHeader(name: string, size: number, isDir: boolean = false): Buffer {
  const buf = Buffer.alloc(512);
  const normalizedName = name.replace(/\\/g, '/');

  // Name (up to 100 chars)
  buf.write(normalizedName.slice(0, 100), 0, 'utf8');
  // Mode
  buf.write(isDir ? '0000755\0' : '0000644\0', 100, 'ascii');
  // UID / GID
  buf.write('0000000\0', 108, 'ascii');
  buf.write('0000000\0', 116, 'ascii');
  // File size in octal (11 digits + null)
  const sizeOctal = (isDir ? 0 : size).toString(8).padStart(11, '0') + '\0';
  buf.write(sizeOctal, 124, 'ascii');
  // Modification time
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
  buf.write(mtimeOctal, 136, 'ascii');
  // Typeflag ('5' directory, '0' normal file)
  buf.write(isDir ? '5' : '0', 156, 'ascii');
  // Magic
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');

  // Checksum
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  const chkOctal = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.write(chkOctal, 148, 'ascii');

  return buf;
}

/**
 * Zero-RAM streaming folder packer.
 * Streams files one by one with disk streams.
 * Handles 5GB, 10GB, 100GB+ folders effortlessly.
 */
export async function packDirectoryToTar(sourceDir: string, destTarPath: string): Promise<number> {
  const destDir = path.dirname(destTarPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const out = fs.createWriteStream(destTarPath);

  async function addDir(currentDir: string, relativePrefix: string): Promise<void> {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      try {
        const full = path.join(currentDir, entry.name);
        const rel = path.join(relativePrefix, entry.name).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          const header = createTarHeader(rel + '/', 0, true);
          out.write(header);
          await addDir(full, rel);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          const header = createTarHeader(rel, stat.size, false);
          out.write(header);

          await new Promise<void>((resolve) => {
            const reader = fs.createReadStream(full);
            reader.pipe(out, { end: false });
            reader.on('end', () => {
              const padSize = (512 - (stat.size % 512)) % 512;
              if (padSize > 0) {
                out.write(Buffer.alloc(padSize));
              }
              resolve();
            });
            reader.on('error', (err) => {
              console.log(`[WARN] Error reading file during archive: ${full}: ${err.message}`);
              resolve();
            });
          });
        }
      } catch (err) {
        console.log(`[WARN] Skipping unreadable entry in directory: ${(err as Error).message}`);
      }
    }
  }

  await addDir(sourceDir, '');
  // Standard TAR EOF: two 512-byte blocks of zeros
  out.write(Buffer.alloc(1024));

  await new Promise<void>((resolve) => {
    out.end(() => resolve());
  });

  const stat = fs.statSync(destTarPath);
  return stat.size;
}

/**
 * Zero-RAM streaming TAR extractor.
 * Extracts files and subdirectories directly to destination.
 */
export async function extractTarArchive(tarPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const fd = fs.openSync(tarPath, 'r');
  const stat = fs.statSync(tarPath);
  let offset = 0;
  const headerBuf = Buffer.alloc(512);

  while (offset + 512 <= stat.size) {
    fs.readSync(fd, headerBuf, 0, 512, offset);
    offset += 512;

    // Check if zero block
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (headerBuf[i] !== 0) {
        isZero = false;
        break;
      }
    }
    if (isZero) break;

    const rawName = headerBuf.subarray(0, 100).toString('utf8').split('\0')[0].trim();
    const type = String.fromCharCode(headerBuf[156]);
    const sizeStr = headerBuf.subarray(124, 136).toString('ascii').split('\0')[0].trim();
    const fileSize = parseInt(sizeStr, 8) || 0;

    if (!rawName) continue;

    const targetPath = path.join(destDir, rawName);
    if (type === '5' || rawName.endsWith('/')) {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const outFd = fs.openSync(targetPath, 'w');
      let bytesLeft = fileSize;
      let readOffset = offset;
      const chunkBuf = Buffer.alloc(Math.min(64 * 1024, fileSize || 1));

      while (bytesLeft > 0) {
        const toRead = Math.min(chunkBuf.length, bytesLeft);
        const bytesRead = fs.readSync(fd, chunkBuf, 0, toRead, readOffset);
        if (bytesRead === 0) break;
        fs.writeSync(outFd, chunkBuf, 0, bytesRead);
        readOffset += bytesRead;
        bytesLeft -= bytesRead;
      }
      fs.closeSync(outFd);

      const padSize = (512 - (fileSize % 512)) % 512;
      offset += fileSize + padSize;
    }
  }

  fs.closeSync(fd);
}
