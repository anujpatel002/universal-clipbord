import * as net from 'node:net';
import * as dgram from 'node:dgram';
import { Bonjour, Service, Browser } from 'bonjour-service';
import { NetworkManager, getAllLocalIpv4Addresses } from './network.js';

const UDP_BEACON_PORT = 49153;

export class DiscoveryService {
  private bonjour: Bonjour | null = null;
  private publishedService: Service | null = null;
  private browser: Browser | null = null;
  private udpSocket: dgram.Socket | null = null;
  private beaconInterval: NodeJS.Timeout | null = null;
  private subnetScanInterval: NodeJS.Timeout | null = null;
  private isScanning = false;

  constructor(private network: NetworkManager) {}

  public start(): void {
    const local = this.network.getLocalInfo();
    if (!local.port) {
      throw new Error('TCP Server must be started before discovery');
    }

    // 1. Engine 1: mDNS Discovery (Bonjour)
    try {
      this.bonjour = new Bonjour();
      this.publishedService = this.bonjour.publish({
        name: `MultiClip-${local.id.slice(0, 8)}`,
        type: 'multiclip',
        port: local.port,
        probe: false,
        txt: {
          id: local.id,
          name: local.name,
          version: local.version,
        },
      });

      this.publishedService.on('error', (err: Error) => {
        console.log(`[WARN] Bonjour publish warning: ${err.message}`);
      });

      this.browser = this.bonjour.find({ type: 'multiclip' }, (service: Service) => {
        this.handleDiscoveredService(service);
      });

      (this.browser as any)?.on?.('error', (err: Error) => {
        console.log(`[WARN] Bonjour browser warning: ${err.message}`);
      });

      console.log(`[INFO] mDNS advertising as MultiClip-${local.id.slice(0, 8)} on port ${local.port}`);
    } catch (err) {
      console.log(`[WARN] mDNS initialization failed: ${(err as Error).message}`);
    }

    // 2. Engine 2: UDP Subnet Broadcast Beacon
    this.startUdpBroadcast();

    // 3. Engine 3: Active Subnet TCP Auto-Sweeper (Guaranteed LAN auto-detection)
    this.startSubnetScanner();
  }

  public triggerSubnetScan(): void {
    if (this.isScanning) return;
    this.isScanning = true;

    const ifaces = getAllLocalIpv4Addresses();
    const portsToProbe = [49152, 49153, 49154];
    const scanPromises: Promise<void>[] = [];

    for (const iface of ifaces) {
      const parts = iface.address.split('.');
      if (parts.length !== 4) continue;
      const subnetBase = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      const localLastOctet = parseInt(parts[3], 10);

      for (let i = 1; i <= 254; i++) {
        if (i === localLastOctet) continue;
        const targetIp = `${subnetBase}${i}`;

        for (const targetPort of portsToProbe) {
          scanPromises.push(
            new Promise<void>((resolve) => {
              const probeSocket = new net.Socket();
              probeSocket.setTimeout(400);

              probeSocket.on('connect', () => {
                probeSocket.destroy();
                this.network.connectToPeer(targetIp, targetPort).catch(() => {});
                resolve();
              });

              probeSocket.on('timeout', () => {
                probeSocket.destroy();
                resolve();
              });

              probeSocket.on('error', () => {
                probeSocket.destroy();
                resolve();
              });

              try {
                probeSocket.connect(targetPort, targetIp);
              } catch {
                resolve();
              }
            })
          );
        }
      }
    }

    Promise.allSettled(scanPromises).finally(() => {
      this.isScanning = false;
    });
  }

  private startSubnetScanner(): void {
    // Initial scan after 500ms
    setTimeout(() => {
      this.triggerSubnetScan();
    }, 500);

    // Periodic sweep every 5 seconds
    this.subnetScanInterval = setInterval(() => {
      this.triggerSubnetScan();
    }, 5000);
  }

  private startUdpBroadcast(): void {
    try {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.udpSocket.on('message', (msg, rinfo) => {
        try {
          const packet = JSON.parse(msg.toString('utf8'));
          if (packet && packet.type === 'MULTICLIP_BEACON') {
            const local = this.network.getLocalInfo();
            if (packet.id === local.id) return;

            const peerIp = rinfo.address;
            const peerPort = packet.port || 49152;
            const peerId = packet.id;

            this.network.connectToPeer(peerIp, peerPort, peerId).catch(() => {});
          }
        } catch {}
      });

      this.udpSocket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
          try {
            this.udpSocket?.close();
          } catch {}
          try {
            this.udpSocket = dgram.createSocket({ type: 'udp4' });
            this.udpSocket.bind(0, () => {
              try { this.udpSocket?.setBroadcast(true); } catch {}
            });
          } catch {}
        }
      });

      this.udpSocket.bind(UDP_BEACON_PORT, '0.0.0.0', () => {
        try {
          this.udpSocket?.setBroadcast(true);
        } catch {}

        this.broadcastBeacon();
        this.beaconInterval = setInterval(() => {
          this.broadcastBeacon();
        }, 3000);
      });
    } catch {}
  }

  private broadcastBeacon(): void {
    if (!this.udpSocket) return;
    const local = this.network.getLocalInfo();
    const payload = Buffer.from(
      JSON.stringify({
        type: 'MULTICLIP_BEACON',
        id: local.id,
        name: local.name,
        port: local.port,
        version: local.version,
      }),
      'utf8'
    );

    try {
      this.udpSocket.send(payload, 0, payload.length, UDP_BEACON_PORT, '255.255.255.255');
    } catch {}

    const ifaces = getAllLocalIpv4Addresses();
    for (const iface of ifaces) {
      if (iface.broadcast && iface.broadcast !== '255.255.255.255') {
        try {
          this.udpSocket.send(payload, 0, payload.length, UDP_BEACON_PORT, iface.broadcast);
        } catch {}
      }
    }
  }

  private handleDiscoveredService(service: Service): void {
    const local = this.network.getLocalInfo();
    const txt = (service.txt || {}) as Record<string, string>;
    const peerId = txt.id;
    const peerName = txt.name || service.name;
    const port = service.port;

    if (peerId === local.id) return;

    let peerIp = '';
    if (service.addresses && service.addresses.length > 0) {
      peerIp = service.addresses.find((addr) => /^\d+\.\d+\.\d+\.\d+$/.test(addr) && !addr.startsWith('172.22.') && !addr.startsWith('172.31.')) ||
               service.addresses.find((addr) => /^\d+\.\d+\.\d+\.\d+$/.test(addr)) ||
               service.addresses[0];
    } else if (service.host) {
      peerIp = service.host;
    }

    if (!peerIp || (peerIp === '127.0.0.1' && peerId === local.id)) {
      return;
    }

    console.log(`[INFO] Discovered peer via mDNS: ${peerName} (${peerId}) at ${peerIp}:${port}`);
    this.network.connectToPeer(peerIp, port, peerId).catch(() => {});
  }

  public stop(): void {
    if (this.subnetScanInterval) {
      clearInterval(this.subnetScanInterval);
      this.subnetScanInterval = null;
    }
    if (this.beaconInterval) {
      clearInterval(this.beaconInterval);
      this.beaconInterval = null;
    }
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {}
      this.udpSocket = null;
    }
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }
    if (this.publishedService) {
      this.publishedService.stop();
      this.publishedService = null;
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }
}
