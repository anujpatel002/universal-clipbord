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
  const [scanning, setScanning] = useState(false);

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

  const handleRescan = async () => {
    setScanning(true);
    try {
      await window.multiclip.rescanPeers();
    } finally {
      setTimeout(() => setScanning(false), 800);
    }
  };

  const onlineCount = devices.filter((d) => d.status === 'online').length;

  return (
    <div className="section-card">
      <div className="section-title">
        <span>LAN Devices ({onlineCount} online)</span>
        <div className="btn-group">
          <button
            className="btn btn-sm btn-secondary"
            onClick={handleRescan}
            disabled={scanning}
            title="Scan entire local subnet for MultiClip PCs"
          >
            {scanning ? 'Scanning...' : '🔄 Rescan LAN'}
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setShowManual(!showManual)}
          >
            {showManual ? 'Close' : '+ Connect IP'}
          </button>
        </div>
      </div>

      {showManual && (
        <form onSubmit={handleManualConnect} className="clipboard-input-form">
          <input
            type="text"
            className="text-input"
            placeholder="Enter peer IP:port (e.g. 192.168.1.15 or 192.168.137.2:49152)"
            value={manualIp}
            onChange={(e) => setManualIp(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={connecting || !manualIp.trim()}>
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      )}

      {devices.length === 0 ? (
        <div className="empty-placeholder">
          <div className="empty-icon">📡</div>
          <div>Auto-scanning local Wi-Fi / Hotspot for other MultiClip PCs...</div>
          <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
            Make sure other PCs are connected to the same Wi-Fi / Router or click "+ Connect IP".
          </div>
        </div>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <div
              key={device.id}
              className={`device-card ${dragOverDevId === device.id ? 'drag-over' : ''}`}
              onDragOver={(e) => handleDragOver(e, device.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, device.id)}
            >
              <div className="device-card-header">
                <div className="device-avatar">💻</div>
                <div className="device-card-info">
                  <div className="device-card-name">
                    {device.trusted && <span className="trusted-icon" title="Trusted Device">✓</span>}
                    <span>{device.name}</span>
                  </div>
                  <div className="device-card-addr">
                    {device.ip}:{device.port}
                  </div>
                </div>
              </div>

              <div className="device-card-footer">
                <span className="dropzone-tip">
                  {device.trusted ? 'Drag files/folders here' : 'Pair to enable sync'}
                </span>
                <div className="btn-group">
                  {device.trusted ? (
                    <>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => onSendFile(device.id)}
                        title="Choose file or folder to send"
                      >
                        📤 Send File
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => onUnpair(device.id)}
                        title="Revoke trust"
                        style={{ padding: '0.3rem 0.5rem' }}
                      >
                        Unpair
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={() => onPair(device.id)}>
                      🔒 Pair & Trust
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
