import { Bonjour, Service, Browser } from 'bonjour-service';
import { NetworkManager } from './network.js';

export class DiscoveryService {
  private bonjour: Bonjour | null = null;
  private publishedService: Service | null = null;
  private browser: Browser | null = null;

  constructor(private network: NetworkManager) {}

  public start(): void {
    const local = this.network.getLocalInfo();
    if (!local.port) {
      throw new Error('TCP Server must be started before discovery');
    }

    this.bonjour = new Bonjour();

    // 1. Publish local device
    this.publishedService = this.bonjour.publish({
      name: `MultiClip-${local.id.slice(0, 8)}`,
      type: 'multiclip',
      port: local.port,
      txt: {
        id: local.id,
        name: local.name,
        version: local.version,
      },
    });

    console.log(`[INFO] mDNS advertising as MultiClip-${local.id.slice(0, 8)} on port ${local.port}`);

    // 2. Discover peers
    this.browser = this.bonjour.find({ type: 'multiclip' }, (service: Service) => {
      this.handleDiscoveredService(service);
    });
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
      // Find IPv4
      peerIp = service.addresses.find((addr) => /^\d+\.\d+\.\d+\.\d+$/.test(addr)) || service.addresses[0];
    } else if (service.host) {
      peerIp = service.host;
    }

    if (!peerIp || peerIp === '127.0.0.1' && peerId === local.id) {
      return;
    }

    console.log(`[INFO] mDNS Discovered peer: ${peerName} (${peerId}) at ${peerIp}:${port}`);

    // Connect to peer over TCP
    this.network.connectToPeer(peerIp, port, peerId).catch((err) => {
      console.log(`[INFO] Could not connect to peer ${peerName} (${peerIp}:${port}): ${err.message}`);
    });
  }

  public stop(): void {
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
