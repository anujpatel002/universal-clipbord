import React, { useState } from 'react';
import { Device } from '../../shared/types.js';

interface DeviceListProps {
  devices: Device[];
  onPair: (deviceId: string) => void;
  onUnpair: (deviceId: string) => void;
  onSendFile: (deviceId: string, filePath?: string) => void;
}

export const DeviceList: React.FC<DeviceListProps> = ({
  devices,
  onPair,
  onUnpair,
  onSendFile,
}) => {
  const [dragOverDevId, setDragOverDevId] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualIp, setManualIp] = useState('');
  const [connecting, setConnecting] = useState(false);

  const handleDragOver = (e: React.DragEvent, deviceId: string) => {
    e.preventDefault();
    setDragOverDevId(deviceId);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverDevId(null);
  };

  const handleDrop = (e: React.DragEvent, deviceId: string) => {
    e.preventDefault();
    setDragOverDevId(null);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const filePath = (file as any).path;
      if (filePath) {
        onSendFile(deviceId, filePath);
      }
    }
  };

  const handleManualConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualIp.trim()) return;
    setConnecting(true);
    try {
      const res = await window.multiclip.connectToIp(manualIp.trim());
      if (res.success) {
        setManualIp('');
        setShowManual(false);
      } else {
        alert(res.error || `Could not connect to ${manualIp.trim()}. Please ensure MultiClip is running on that PC and firewall allows local connections.`);
      }
    } catch (err) {
      alert(`Connection error: ${(err as Error).message}`);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="section-card">
      <div className="section-title">
        <span>Devices on LAN (Auto-Discovered & Direct)</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {devices.filter((d) => d.status === 'online').length} online
          </span>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setShowManual(!showManual)}
            style={{ fontSize: '0.75rem', padding: '3px 8px' }}
          >
            {showManual ? 'Close' : '+ Connect IP'}
          </button>
        </div>
      </div>

      {showManual && (
        <form onSubmit={handleManualConnect} style={{ display: 'flex', gap: '8px', marginBottom: '12px', padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px' }}>
          <input
            type="text"
            className="input-field"
            placeholder="Enter peer IP (e.g. 192.168.1.15)"
            value={manualIp}
            onChange={(e) => setManualIp(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', fontSize: '0.85rem' }}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={connecting || !manualIp.trim()}>
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      )}

      <div className="device-list">
        {devices.length === 0 ? (
          <div className="empty-state">
            Scanning LAN with mDNS & UDP broadcast...<br/>
            <span style={{ fontSize: '0.8rem', opacity: 0.75 }}>
              Tip: Ensure both PCs are on the same Wi-Fi / Router. You can also click "+ Connect IP" above.
            </span>
          </div>
        ) : (
          devices.map((device) => (
            <div
              key={device.id}
              className={`device-item ${device.status} ${dragOverDevId === device.id ? 'drag-over' : ''}`}
              onDragOver={(e) => handleDragOver(e, device.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, device.id)}
            >
              <div className="device-meta">
                <div className="device-name-row">
                  {device.trusted && <span className="trusted-badge" title="Trusted Device">✓</span>}
                  <span>{device.name}</span>
                </div>
                <div className="device-addr">
                  {device.ip}:{device.port} &bull; {device.status}
                </div>
              </div>

              <div className="device-actions">
                {device.trusted ? (
                  <>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => onSendFile(device.id)}
                      title="Select and send file"
                    >
                      Send File
                    </button>
                    <span style={{ fontSize: '0.75rem', color: 'var(--success)', fontWeight: 600 }}>
                      Trusted
                    </span>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => onUnpair(device.id)}
                      title="Revoke trust"
                      style={{ fontSize: '0.7rem' }}
                    >
                      Unpair
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm" onClick={() => onPair(device.id)}>
                    Pair Device
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
