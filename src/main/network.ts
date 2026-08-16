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

export function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const ifaceList = interfaces[name];
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
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
          console.log(`[INFO] TCP Server listening on ${this.localIp}:${this.port}`);
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
        this.handlePeerDisconnected(remoteDeviceId);
      }
    });

    socket.on('error', (err) => {
      console.log(`[WARN] Inbound socket error: ${err.message}`);
    });
  }

  public connectToPeer(ip: string, port: number, expectedDeviceId?: string): Promise<Device> {
    return new Promise((resolve, reject) => {
      const local = this.getLocalInfo();
      if (expectedDeviceId && expectedDeviceId === local.id) {
        return reject(new Error('Cannot connect to self'));
      }

      if (expectedDeviceId && this.connections.has(expectedDeviceId)) {
        const conn = this.connections.get(expectedDeviceId)!;
        return resolve(conn.device);
      }

      const socket = net.createConnection({ host: ip, port }, () => {
        const local = this.getLocalInfo();
        const identity = this.security.getIdentity();
        const helloMsg: ProtocolMessage<HelloPayload> = {
          type: 'HELLO',
          payload: {
            deviceId: local.id,
            deviceName: local.name,
            port: this.port,
            version: this.version,
            publicKey: identity.publicKey,
          },
        };
        socket.write(encodeMessage(helloMsg));
      });

      const framer = new MessageFramer();
      let peerId: string | null = expectedDeviceId || null;

      socket.on('data', (data) => framer.push(data));

      framer.on('message', (msg: ProtocolMessage) => {
        if (msg.type === 'HELLO' || msg.type === 'HELLO_ACK') {
          const hello = msg.payload as HelloPayload;
          peerId = hello.deviceId;
          const dev = this.registerPeer(hello.deviceId, hello.deviceName, ip, port, socket, framer, hello.publicKey);
          resolve(dev);
        } else {
          this.processIncomingMessage(socket, framer, msg, (id) => {
            peerId = id;
          });
        }
      });

      framer.on('chunk', (chunk) => {
        this.emit('chunk', { deviceId: peerId, chunk });
      });

      socket.on('close', () => {
        if (peerId) {
          this.handlePeerDisconnected(peerId);
        }
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
    setRemoteId: (id: string) => void
  ): void {
    if (msg.type === 'HELLO') {
      const hello = msg.payload as HelloPayload;
      setRemoteId(hello.deviceId);
      const remoteIp = socket.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';
      this.registerPeer(hello.deviceId, hello.deviceName, remoteIp, hello.port, socket, framer, hello.publicKey);

      const local = this.getLocalInfo();
      const identity = this.security.getIdentity();
      const ackMsg: ProtocolMessage<HelloPayload> = {
        type: 'HELLO_ACK',
        payload: {
          deviceId: local.id,
          deviceName: local.name,
          port: this.port,
          version: this.version,
          publicKey: identity.publicKey,
        },
      };
      socket.write(encodeMessage(ackMsg));
      return;
    }

    if (msg.type === 'PAIR_REQUEST') {
      const req = msg.payload as PairRequestPayload;
      setRemoteId(req.deviceId);

      // Verify digital signature on nonce
      const isValid = this.security.verify(req.nonce, req.signature, req.publicKey);
      if (!isValid) {
        console.log(`[WARN] Invalid cryptographic signature from ${req.deviceName} (${req.deviceId})`);
        return;
      }

      // Update peer publicKey
      const dev = this.knownDevices.get(req.deviceId);
      if (dev) {
        dev.publicKey = req.publicKey;
        this.db.upsertDevice(dev);
      }

      const remoteIp = socket.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';
      this.emit('pairing_request', {
        deviceId: req.deviceId,
        deviceName: req.deviceName,
        ip: dev?.ip || remoteIp,
        port: dev?.port || 0,
        timestamp: Date.now(),
      });
      return;
    }

    if (msg.type === 'PAIR_ACCEPT') {
      const accept = msg.payload as PairAcceptPayload;
      setRemoteId(accept.deviceId);

      // Verify signature
      const isValid = this.security.verify(accept.nonce, accept.signature, accept.publicKey);
      if (isValid) {
        this.setDeviceTrusted(accept.deviceId, true);
        console.log(`[INFO] Pairing accepted and verified for device ${accept.deviceName} (${accept.deviceId})`);
      } else {
        console.log(`[WARN] Failed to verify signature for PAIR_ACCEPT from ${accept.deviceId}`);
      }
      return;
    }

    if (msg.type === 'PAIR_REJECT') {
      const reject = msg.payload as PairRejectPayload;
      setRemoteId(reject.deviceId);
      console.log(`[INFO] Pairing rejected by ${reject.deviceId}: ${reject.reason || 'No reason'}`);
      return;
    }

    // Default message routing
    const senderDev = Array.from(this.connections.entries()).find(([, conn]) => conn.socket === socket);
    const senderId = senderDev ? senderDev[0] : null;
    this.emit('message', { deviceId: senderId, message: msg });
  }

  public sendPairRequest(targetDeviceId: string): boolean {
    const conn = this.connections.get(targetDeviceId);
    if (!conn) return false;

    const local = this.getLocalInfo();
    const identity = this.security.getIdentity();
    const nonce = this.security.createChallenge();
    const signature = this.security.sign(nonce);

    const pairMsg: ProtocolMessage<PairRequestPayload> = {
      type: 'PAIR_REQUEST',
      payload: {
        deviceId: local.id,
        deviceName: local.name,
        publicKey: identity.publicKey,
        nonce,
        signature,
      },
    };

    return this.sendMessage(targetDeviceId, pairMsg);
  }

  public respondToPairRequest(targetDeviceId: string, accept: boolean): boolean {
    const conn = this.connections.get(targetDeviceId);
    if (!conn) return false;

    const local = this.getLocalInfo();
    const identity = this.security.getIdentity();

    if (accept) {
      const nonce = this.security.createChallenge();
      const signature = this.security.sign(nonce);

      const acceptMsg: ProtocolMessage<PairAcceptPayload> = {
        type: 'PAIR_ACCEPT',
        payload: {
          deviceId: local.id,
          deviceName: local.name,
          publicKey: identity.publicKey,
          nonce,
          signature,
        },
      };

      this.sendMessage(targetDeviceId, acceptMsg);
      this.setDeviceTrusted(targetDeviceId, true);
      return true;
    } else {
      const rejectMsg: ProtocolMessage<PairRejectPayload> = {
        type: 'PAIR_REJECT',
        payload: {
          deviceId: local.id,
          reason: 'Pairing rejected by user',
        },
      };
      this.sendMessage(targetDeviceId, rejectMsg);
      return false;
    }
  }

  private registerPeer(
    deviceId: string,
    deviceName: string,
    ip: string,
    port: number,
    socket: net.Socket,
    framer: MessageFramer,
    publicKey?: string
  ): Device {
    const existing = this.knownDevices.get(deviceId) || this.db.getDevice(deviceId);
    const trusted = existing ? existing.trusted : false;

    const device: Device = {
      id: deviceId,
      name: deviceName,
      ip,
      port,
      trusted,
      lastSeen: Date.now(),
      status: 'online',
      publicKey: publicKey || existing?.publicKey,
    };

    this.knownDevices.set(deviceId, device);
    this.connections.set(deviceId, { deviceId, socket, framer, device });
    this.db.upsertDevice(device);

    this.emit('devices_updated', this.getAllDevices());
    return device;
  }

  private handlePeerDisconnected(deviceId: string): void {
    this.connections.delete(deviceId);
    const dev = this.knownDevices.get(deviceId);
    if (dev) {
      dev.status = 'offline';
      dev.lastSeen = Date.now();
      this.knownDevices.set(deviceId, dev);
      this.db.upsertDevice(dev);
    }
    this.emit('devices_updated', this.getAllDevices());
  }

  public sendMessage(targetDeviceId: string, message: ProtocolMessage): boolean {
    const conn = this.connections.get(targetDeviceId);
    if (!conn || conn.socket.destroyed) {
      return false;
    }
    conn.socket.write(encodeMessage(message));
    return true;
  }

  public broadcastMessage(message: ProtocolMessage, trustedOnly = false): void {
    const raw = encodeMessage(message);
    for (const conn of this.connections.values()) {
      if (!trustedOnly || conn.device.trusted) {
        if (!conn.socket.destroyed) {
          conn.socket.write(raw);
        }
      }
    }
  }

  public sendChunk(targetDeviceId: string, rawChunkFrame: Buffer): boolean {
    const conn = this.connections.get(targetDeviceId);
    if (!conn || conn.socket.destroyed) {
      return false;
    }
    return conn.socket.write(rawChunkFrame);
  }

  public setDeviceTrusted(deviceId: string, trusted: boolean): void {
    const dev = this.knownDevices.get(deviceId);
    if (dev) {
      dev.trusted = trusted;
      this.knownDevices.set(deviceId, dev);
      this.db.setDeviceTrusted(deviceId, trusted);
      this.emit('devices_updated', this.getAllDevices());
    }
  }

  public stop(): void {
    for (const conn of this.connections.values()) {
      conn.socket.destroy();
    }
    this.connections.clear();
    this.server?.close();
  }
}
