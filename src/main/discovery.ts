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

  constructor(private network: NetworkManager) {}

  public start(): void {
    const local = this.network.getLocalInfo();
    if (!local.port) {
      throw new Error('TCP Server must be started before discovery');
    }

    // 1. Start mDNS Discovery
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

    // 2. Start UDP Subnet Broadcast Beacon (Fast & resilient across all routers)
    this.startUdpBroadcast();
  }

  private startUdpBroadcast(): void {
    try {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.udpSocket.on('message', (msg, rinfo) => {
        try {
          const packet = JSON.parse(msg.toString('utf8'));
          if (packet && packet.type === 'MULTICLIP_BEACON') {
            const local = this.network.getLocalInfo();
            // Skip self
            if (packet.id === local.id) return;

            const peerIp = rinfo.address;
            const peerPort = packet.port || 49152;
            const peerId = packet.id;

            this.network.connectToPeer(peerIp, peerPort, peerId).catch(() => {
              // Peer may already be connected
            });
          }
        } catch {
          // Ignored
        }
      });

      this.udpSocket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
          // Port 49153 restricted on this OS; fallback to dynamic sending port
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
        } catch {
          // Ignored
        }

        // Send initial beacon immediately
        this.broadcastBeacon();

        // Repeat beacon every 3 seconds
        this.beaconInterval = setInterval(() => {
          this.broadcastBeacon();
        }, 3000);
      });
    } catch {
      // Ignored
    }
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

    // Broadcast to global 255.255.255.255
    try {
      this.udpSocket.send(payload, 0, payload.length, UDP_BEACON_PORT, '255.255.255.255');
    } catch {
      // Ignored
    }

    // Broadcast to each detected physical interface subnet
    const ifaces = getAllLocalIpv4Addresses();
    for (const iface of ifaces) {
      if (iface.broadcast && iface.broadcast !== '255.255.255.255') {
        try {
          this.udpSocket.send(payload, 0, payload.length, UDP_BEACON_PORT, iface.broadcast);
        } catch {
          // Ignored
        }
      }
    }
  }

  private handleDiscoveredService(service: Service): void {
    const local = this.network.getLocalInfo();
    const txt = (service.txt || {}) as Record<string, string>;
    const peerId = txt.id;
    const peerName = txt.name || service.name;
    const port = service.port;

    // Skip self
    if (peerId === local.id) {
      return;
    }

    // Find valid IPv4 address
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

    console.log(`[INFO] Discovered peer: ${peerName} (${peerId}) at ${peerIp}:${port}`);
    this.network.connectToPeer(peerIp, port, peerId).catch(() => {
      // Handled in NetworkManager
    });
  }

  public stop(): void {
    if (this.beaconInterval) {
      clearInterval(this.beaconInterval);
      this.beaconInterval = null;
    }
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // Ignored
      }
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
