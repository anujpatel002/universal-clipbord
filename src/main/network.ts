import * as net from 'node:net';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  Device,
  LocalDeviceInfo,
  ProtocolMessage,
  HelloPayload,
  PairRequestPayload,
  PairAcceptPayload,
  PairRejectPayload,
} from '../shared/types.js';
import { MessageFramer, encodeMessage } from './protocol.js';
import { AppDatabase } from './database.js';
import { SecurityManager } from './security.js';

export interface LocalInterfaceInfo {
  name: string;
  address: string;
  broadcast: string;
}

export function getAllLocalIpv4Addresses(): LocalInterfaceInfo[] {
  const interfaces = os.networkInterfaces();
  const results: LocalInterfaceInfo[] = [];

  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    // Exclude virtual switches, WSL, Hyper-V, Docker, VMware, VirtualBox, Loopback
    if (
      lower.includes('vethernet') ||
      lower.includes('wsl') ||
      lower.includes('virtual') ||
      lower.includes('vmware') ||
      lower.includes('vbox') ||
      lower.includes('hyper-v') ||
      lower.includes('docker') ||
      lower.includes('loopback') ||
      lower.includes('bluetooth')
    ) {
      continue;
    }

    const ifaceList = interfaces[name];
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        let broadcast = '255.255.255.255';
        if (iface.netmask) {
          try {
            const ipParts = iface.address.split('.').map(Number);
            const maskParts = iface.netmask.split('.').map(Number);
            const bcastParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)));
            broadcast = bcastParts.join('.');
          } catch {
            broadcast = '255.255.255.255';
          }
        }
        results.push({ name, address: iface.address, broadcast });
      }
    }
  }

  // Fallback if all adapters were filtered out
  if (results.length === 0) {
    for (const name of Object.keys(interfaces)) {
      const ifaceList = interfaces[name];
      if (!ifaceList) continue;
      for (const iface of ifaceList) {
        if (iface.family === 'IPv4' && !iface.internal) {
          results.push({ name, address: iface.address, broadcast: '255.255.255.255' });
        }
      }
    }
  }

  return results;
}

export function getLocalIpAddress(): string {
  const addrs = getAllLocalIpv4Addresses();
  const wifiOrEth = addrs.find((a) => {
    const lower = a.name.toLowerCase();
    return (
      lower.includes('wi-fi') ||
      lower.includes('wifi') ||
      lower.includes('ethernet') ||
      lower.includes('wlan') ||
      lower.includes('en0') ||
      lower.includes('eth')
    );
  });

  if (wifiOrEth) return wifiOrEth.address;
  if (addrs.length > 0) return addrs[0].address;
  return '127.0.0.1';
}

export interface PeerConnection {
  deviceId: string;
  socket: net.Socket;
  framer: MessageFramer;
  device: Device;
}

export class NetworkManager extends EventEmitter {
  private server: net.Server | null = null;
  private port: number = 0;
  private localIp: string;
  private connections: Map<string, PeerConnection> = new Map(); // deviceId -> PeerConnection
  private knownDevices: Map<string, Device> = new Map();
  private pendingPairNonces: Map<string, string> = new Map();
  private incomingPairNonces: Map<string, string> = new Map();

  constructor(
    private db: AppDatabase,
    private security: SecurityManager,
    private version: string = '1.0.0'
  ) {
    super();
    this.localIp = getLocalIpAddress();
    this.loadKnownDevices();
  }

  private loadKnownDevices(): void {
    const saved = this.db.getDevices();
    for (const dev of saved) {
      this.knownDevices.set(dev.id, dev);
    }
  }

  public getLocalInfo(): LocalDeviceInfo {
    const identity = this.security.getIdentity();
    return {
      id: identity.deviceId,
      name: identity.deviceName,
      ip: this.localIp,
      port: this.port,
      version: this.version,
    };
  }

  public getAllDevices(): Device[] {
    return Array.from(this.knownDevices.values());
  }

  public getDevice(deviceId: string): Device | undefined {
    return this.knownDevices.get(deviceId) || (this.db.getDevice(deviceId) ?? undefined);
  }

  public async startServer(preferredPort = 49152): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleInboundConnection(socket));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.server?.listen(0, '0.0.0.0');
        } else {
          this.emit('error', err);
          reject(err);
        }
      });

      this.server.listen(preferredPort, '0.0.0.0', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          console.log(`[INFO] TCP Server listening on 0.0.0.0:${this.port} (Primary IP: ${this.localIp})`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to obtain server address'));
        }
      });
    });
  }

  private handleInboundConnection(socket: net.Socket): void {
    const framer = new MessageFramer();
    let remoteDeviceId: string | null = null;

    socket.on('data', (data) => framer.push(data));

    framer.on('message', (msg: ProtocolMessage) => {
      this.processIncomingMessage(socket, framer, msg, (devId) => {
        remoteDeviceId = devId;
      });
    });

    framer.on('chunk', (chunk) => {
      this.emit('chunk', { deviceId: remoteDeviceId, chunk });
    });

    socket.on('close', () => {
      if (remoteDeviceId) {
        const dev = this.knownDevices.get(remoteDeviceId);
        if (dev) {
          dev.status = 'offline';
          this.emit('devices_updated', this.getAllDevices());
        }
        this.connections.delete(remoteDeviceId);
      }
    });

    socket.on('error', (err) => {
      console.log(`[WARN] Inbound socket error: ${err.message}`);
    });
  }

  public async connectToPeer(ip: string, port: number, knownDeviceId?: string): Promise<Device> {
    if (knownDeviceId && this.connections.has(knownDeviceId)) {
      const existing = this.connections.get(knownDeviceId)!;
      if (!existing.socket.destroyed) {
        return existing.device;
      }
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: ip, port }, () => {
        const framer = new MessageFramer();
        let peerDevId = knownDeviceId || '';

        socket.on('data', (data) => framer.push(data));

        framer.on('message', (msg: ProtocolMessage) => {
          this.processIncomingMessage(socket, framer, msg, (devId) => {
            peerDevId = devId;
          });
        });

        framer.on('chunk', (chunk) => {
          this.emit('chunk', { deviceId: peerDevId, chunk });
        });

        socket.on('close', () => {
          if (peerDevId) {
            const dev = this.knownDevices.get(peerDevId);
            if (dev) {
              dev.status = 'offline';
              this.emit('devices_updated', this.getAllDevices());
            }
            this.connections.delete(peerDevId);
          }
        });

        socket.on('error', (err) => {
          console.log(`[WARN] Peer socket error (${ip}:${port}): ${err.message}`);
        });

        // Send HELLO handshake immediately
        const local = this.getLocalInfo();
        const helloMsg: ProtocolMessage<HelloPayload> = {
          type: 'HELLO',
          payload: {
            deviceId: local.id,
            deviceName: local.name,
            port: this.port,
            version: local.version,
          },
        };
        socket.write(encodeMessage(helloMsg));

        const existingDb = peerDevId ? this.db.getDevice(peerDevId) : null;
        const device: Device = {
          id: peerDevId || `peer-${ip}`,
          name: existingDb?.name || 'Unknown',
          ip,
          port,
          status: 'online',
          trusted: existingDb ? existingDb.trusted : false,
          lastSeen: Date.now(),
          publicKey: existingDb?.publicKey,
        };

        const conn: PeerConnection = {
          deviceId: device.id,
          socket,
          framer,
          device,
        };

        if (peerDevId) {
          this.knownDevices.set(peerDevId, device);
          this.db.upsertDevice(device);
          this.connections.set(peerDevId, conn);
        }

        resolve(device);
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  private processIncomingMessage(
    socket: net.Socket,
    framer: MessageFramer,
    msg: ProtocolMessage,
    onDeviceIdIdentified: (id: string) => void
  ): void {
    const remoteIp = socket.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';

    switch (msg.type) {
      case 'HELLO': {
        const payload = msg.payload as HelloPayload;
        onDeviceIdIdentified(payload.deviceId);

        const existing = this.db.getDevice(payload.deviceId);
        const device: Device = {
          id: payload.deviceId,
          name: payload.deviceName,
          ip: remoteIp,
          port: payload.port,
          status: 'online',
          trusted: existing ? existing.trusted : false,
          lastSeen: Date.now(),
          publicKey: existing?.publicKey,
        };

        this.knownDevices.set(device.id, device);
        this.db.upsertDevice(device);

        const conn: PeerConnection = {
          deviceId: device.id,
          socket,
          framer,
          device,
        };
        this.connections.set(device.id, conn);

        // Reply with HELLO if this connection hasn't been greeted yet
        if (!socket.destroyed) {
          const local = this.getLocalInfo();
          socket.write(
            encodeMessage<HelloPayload>({
              type: 'HELLO_ACK',
              payload: {
                deviceId: local.id,
                deviceName: local.name,
                port: this.port,
                version: local.version,
              },
            })
          );
        }

        this.emit('devices_updated', this.getAllDevices());
        console.log(`[INFO] Connected with peer: ${device.name} (${device.id}) at ${device.ip}:${device.port}`);
        break;
      }

      case 'HELLO_ACK': {
        const payload = msg.payload as HelloPayload;
        onDeviceIdIdentified(payload.deviceId);

        const existing = this.db.getDevice(payload.deviceId);
        const device: Device = {
          id: payload.deviceId,
          name: payload.deviceName,
          ip: remoteIp,
          port: payload.port,
          status: 'online',
          trusted: existing ? existing.trusted : false,
          lastSeen: Date.now(),
          publicKey: existing?.publicKey,
        };

        this.knownDevices.set(device.id, device);
        this.db.upsertDevice(device);

        const conn: PeerConnection = {
          deviceId: device.id,
          socket,
          framer,
          device,
        };
        this.connections.set(device.id, conn);

        this.emit('devices_updated', this.getAllDevices());
        break;
      }

      case 'PAIR_REQUEST': {
        const payload = msg.payload as PairRequestPayload;
        console.log(`[INFO] Received pairing request from ${payload.deviceName} (${payload.deviceId})`);
        
        // Verify sender's signature on their nonce
        const valid = this.security.verify(payload.nonce, payload.signature, payload.publicKey);
        if (!valid) {
          console.log(`[WARN] Invalid signature on PAIR_REQUEST from ${payload.deviceId}`);
          return;
        }

        this.incomingPairNonces.set(payload.deviceId, payload.nonce);

        this.emit('pairing_request', {
          deviceId: payload.deviceId,
          deviceName: payload.deviceName,
          ip: remoteIp,
          port: this.knownDevices.get(payload.deviceId)?.port || 49152,
          timestamp: Date.now(),
          publicKey: payload.publicKey,
          nonce: payload.nonce,
        });
        break;
      }

      case 'PAIR_ACCEPT': {
        const payload = msg.payload as PairAcceptPayload;
        const expectedNonce = this.pendingPairNonces.get(payload.deviceId);
        const valid = this.security.verify(payload.nonce, payload.signature, payload.publicKey);
        
        if (valid && (!expectedNonce || expectedNonce === payload.nonce)) {
          this.pendingPairNonces.delete(payload.deviceId);
          this.setDeviceTrusted(payload.deviceId, true, payload.publicKey);
          console.log(`[INFO] Pairing accepted and verified for device ${payload.deviceId}`);
        } else {
          console.log(`[WARN] Signature verification failed for PAIR_ACCEPT from ${payload.deviceId}`);
        }
        break;
      }

      case 'PAIR_REJECT': {
        const payload = msg.payload as PairRejectPayload;
        console.log(`[INFO] Pairing rejected by ${payload.deviceId}: ${payload.reason || 'No reason'}`);
        this.pendingPairNonces.delete(payload.deviceId);
        this.setDeviceTrusted(payload.deviceId, false);
        break;
      }

      default: {
        this.emit('message', {
          deviceId: this.findDeviceIdBySocket(socket),
          message: msg,
        });
        break;
      }
    }
  }

  private findDeviceIdBySocket(socket: net.Socket): string | null {
    for (const [id, conn] of this.connections.entries()) {
      if (conn.socket === socket) return id;
    }
    return null;
  }

  public setDeviceTrusted(deviceId: string, trusted: boolean, publicKey?: string): void {
    const dev = this.knownDevices.get(deviceId);
    if (dev) {
      dev.trusted = trusted;
      if (publicKey) dev.publicKey = publicKey;
      this.db.upsertDevice(dev);
      this.db.setDeviceTrusted(deviceId, trusted);
      this.emit('devices_updated', this.getAllDevices());
    }
  }

  public sendPairRequest(targetDeviceId: string): boolean {
    const conn = this.connections.get(targetDeviceId);
    if (!conn) return false;

    const identity = this.security.getIdentity();
    const nonce = this.security.createChallenge();
    const signature = this.security.sign(nonce);
    this.pendingPairNonces.set(targetDeviceId, nonce);

    const payload: PairRequestPayload = {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      publicKey: identity.publicKey,
      nonce,
      signature,
    };

    conn.socket.write(encodeMessage({ type: 'PAIR_REQUEST', payload }));
    return true;
  }

  public respondToPairRequest(targetDeviceId: string, accept: boolean, reqNonce?: string): void {
    const conn = this.connections.get(targetDeviceId);
    if (!conn) return;

    const identity = this.security.getIdentity();

    if (accept) {
      const nonceToSign = reqNonce || this.incomingPairNonces.get(targetDeviceId) || this.security.createChallenge();
      const signature = this.security.sign(nonceToSign);

      const payload: PairAcceptPayload = {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        publicKey: identity.publicKey,
        nonce: nonceToSign,
        signature,
      };

      conn.socket.write(encodeMessage({ type: 'PAIR_ACCEPT', payload }));
      this.setDeviceTrusted(targetDeviceId, true);
    } else {
      const payload: PairRejectPayload = {
        deviceId: identity.deviceId,
        reason: 'User declined pairing request',
      };
      conn.socket.write(encodeMessage({ type: 'PAIR_REJECT', payload }));
      this.setDeviceTrusted(targetDeviceId, false);
    }
  }

  public sendMessage(targetDeviceId: string, msg: ProtocolMessage): boolean {
    const conn = this.connections.get(targetDeviceId);
    if (!conn || conn.socket.destroyed) return false;
    conn.socket.write(encodeMessage(msg));
    return true;
  }

  public sendRawData(targetDeviceId: string, data: Buffer): boolean {
    const conn = this.connections.get(targetDeviceId);
    if (!conn || conn.socket.destroyed) return false;
    return conn.socket.write(data);
  }

  public sendChunk(targetDeviceId: string, chunkFrame: Buffer): boolean {
    return this.sendRawData(targetDeviceId, chunkFrame);
  }

  public broadcastMessage(msg: ProtocolMessage, trustedOnly = false): void {
    const encoded = encodeMessage(msg);
    for (const conn of this.connections.values()) {
      if (trustedOnly && !conn.device.trusted) continue;
      if (!conn.socket.destroyed) {
        conn.socket.write(encoded);
      }
    }
  }

  public stop(): void {
    for (const conn of this.connections.values()) {
      conn.socket.destroy();
    }
    this.connections.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
