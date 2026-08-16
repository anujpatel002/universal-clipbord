import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { AppDatabase } from './database.js';

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  privateKey: string;
}

export class SecurityManager {
  private identity: DeviceIdentity;

  constructor(private db: AppDatabase) {
    this.identity = this.loadOrGenerateIdentity();
  }

  private loadOrGenerateIdentity(): DeviceIdentity {
    let deviceId = this.db.getSetting('device_id');
    let deviceName = this.db.getSetting('device_name');
    let publicKey = this.db.getSetting('public_key');
    let privateKey = this.db.getSetting('private_key');

    if (!deviceId || !publicKey || !privateKey) {
      deviceId = crypto.randomUUID();
      deviceName = os.hostname() || `PC-${deviceId.slice(0, 6)}`;

      // Generate persistent Ed25519 keypair
      const keypair = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      publicKey = keypair.publicKey;
      privateKey = keypair.privateKey;

      this.db.setSetting('device_id', deviceId);
      this.db.setSetting('device_name', deviceName);
      this.db.setSetting('public_key', publicKey);
      this.db.setSetting('private_key', privateKey);
    }

    if (!deviceName) {
      deviceName = os.hostname() || `PC-${deviceId.slice(0, 6)}`;
      this.db.setSetting('device_name', deviceName);
    }

    return {
      deviceId,
      deviceName,
      publicKey,
      privateKey,
    };
  }

  public getIdentity(): DeviceIdentity {
    return this.identity;
  }

  public createChallenge(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  public sign(data: string | Buffer): string {
    const sign = crypto.sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), this.identity.privateKey);
    return sign.toString('base64');
  }

  public verify(data: string | Buffer, signature: string, publicKeyPem: string): boolean {
    try {
      return crypto.verify(
        null,
        Buffer.isBuffer(data) ? data : Buffer.from(data),
        publicKeyPem,
        Buffer.from(signature, 'base64')
      );
    } catch {
      return false;
    }
  }

  // AES-256-GCM symmetric encryption utility for sensitive payloads
  public encrypt(plainText: string, key: Buffer): { iv: string; data: string; tag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      data: encrypted,
      tag: tag.toString('hex'),
    };
  }

  public decrypt(encrypted: { iv: string; data: string; tag: string }, key: Buffer): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
    let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
