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

  return (
    <div className="section-card">
      <div className="section-title">
        <span>Devices on LAN (Drag & Drop files to send)</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {devices.filter((d) => d.status === 'online').length} online
        </span>
      </div>

      <div className="device-list">
        {devices.length === 0 ? (
          <div className="empty-state">No other MultiClip devices discovered yet.</div>
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
