import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// Precomputed CRC32 lookup table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

export function crc32(buf: Buffer): number {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

export function calculateFolderSize(dirPath: string): number {
  let total = 0;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const full = path.join(dirPath, file);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        total += calculateFolderSize(full);
      } else {
        total += stat.size;
      }
    }
  } catch {
    // Return accumulated so far
  }
  return total;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  compressed: Buffer;
  crc: number;
  size: number;
  compSize: number;
  offset?: number;
}

/**
 * Compresses an entire folder directory into a standard, 100% compliant .zip file
 */
export async function zipFolder(dirPath: string, outputZipPath: string): Promise<string> {
  const entries: ZipEntry[] = [];

  function scan(current: string, rel: string): void {
    const files = fs.readdirSync(current);
    for (const f of files) {
      const full = path.join(current, f);
      const relPath = rel ? `${rel}/${f}` : f;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        scan(full, relPath);
      } else {
        const data = fs.readFileSync(full);
        const compressed = zlib.deflateRawSync(data, { level: 6 });
        entries.push({
          name: relPath.replace(/\\/g, '/'),
          data,
          compressed,
          crc: crc32(data),
          size: data.length,
          compSize: compressed.length,
        });
      }
    }
  }

  scan(dirPath, '');

  const localHeaders: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    e.offset = offset;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // Signature
    header.writeUInt16LE(20, 4);        // Version needed
    header.writeUInt16LE(0, 6);         // General flags
    header.writeUInt16LE(8, 8);         // Compression: Deflate
    header.writeUInt16LE(0, 10);        // Time
    header.writeUInt16LE(0, 12);        // Date
    header.writeUInt32LE(e.crc, 14);
    header.writeUInt32LE(e.compSize, 18);
    header.writeUInt32LE(e.size, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    localHeaders.push(header, nameBuf, e.compressed);
    offset += header.length + nameBuf.length + e.compressed.length;
  }

  const centralDir: Buffer[] = [];
  const cdStart = offset;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // Signature
    cdHeader.writeUInt16LE(20, 4);         // Version made by
    cdHeader.writeUInt16LE(20, 6);         // Version needed
    cdHeader.writeUInt16LE(0, 8);          // Flags
    cdHeader.writeUInt16LE(8, 10);         // Compression: Deflate
    cdHeader.writeUInt16LE(0, 12);         // Time
    cdHeader.writeUInt16LE(0, 14);         // Date
    cdHeader.writeUInt32LE(e.crc, 16);
    cdHeader.writeUInt32LE(e.compSize, 20);
    cdHeader.writeUInt32LE(e.size, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(e.offset || 0, 42);

    centralDir.push(cdHeader, nameBuf);
    offset += cdHeader.length + nameBuf.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // End of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);   // Entries on disk
  eocd.writeUInt16LE(entries.length, 10);  // Total entries
  eocd.writeUInt32LE(cdSize, 12);          // Central directory size
  eocd.writeUInt32LE(cdStart, 16);         // Central directory offset
  eocd.writeUInt16LE(0, 20);

  const fullBuf = Buffer.concat([...localHeaders, ...centralDir, eocd]);
  fs.mkdirSync(path.dirname(outputZipPath), { recursive: true });
  fs.writeFileSync(outputZipPath, fullBuf);

  return outputZipPath;
}

/**
 * Extracts a standard .zip archive to target destination directory
 */
export async function unzipArchive(zipPath: string, targetExtractDir: string): Promise<string> {
  const buf = fs.readFileSync(zipPath);
  let pos = 0;

  fs.mkdirSync(targetExtractDir, { recursive: true });

  while (pos < buf.length - 4) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x04034b50) break; // Reached end of local file headers

    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.toString('utf8', pos + 30, pos + 30 + nameLen);
    const dataStart = pos + 30 + nameLen + extraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let uncompData: Buffer;
    if (method === 8) {
      uncompData = zlib.inflateRawSync(compData);
    } else {
      uncompData = compData;
    }

    const outPath = path.join(targetExtractDir, name);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, uncompData);

    pos = dataStart + compSize;
  }

  return targetExtractDir;
}
