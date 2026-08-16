import React, { useState } from 'react';
import { ClipboardItem, Device } from '../../shared/types.js';

interface ClipboardSectionProps {
  items: ClipboardItem[];
  devices: Device[];
  onBroadcastText: (text: string) => void;
  onSendToDevice: (deviceId: string, item: ClipboardItem) => void;
  onCopyToClipboard: (text: string) => void;
  onRequestFile: (sourceDeviceId: string, remoteFilePath: string) => void;
  onClearHistory: () => void;
}

export const ClipboardSection: React.FC<ClipboardSectionProps> = ({
  items,
  devices,
  onBroadcastText,
  onSendToDevice,
  onCopyToClipboard,
  onRequestFile,
  onClearHistory,
}) => {
  const [inputText, setInputText] = useState('');
  const [selectedTarget, setSelectedTarget] = useState<string>('broadcast');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const formatBytes = (bytes: number): string => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    if (selectedTarget === 'broadcast') {
      onBroadcastText(inputText.trim());
    } else {
      const dummyItem: ClipboardItem = {
        id: crypto.randomUUID(),
        type: 'text',
        content: inputText.trim(),
        sourceDeviceId: 'local',
        sourceDeviceName: 'This PC',
        timestamp: Date.now(),
      };
      onSendToDevice(selectedTarget, dummyItem);
    }
    setInputText('');
  };

  const handleCopy = (item: ClipboardItem) => {
    if (item.content) {
      onCopyToClipboard(item.content);
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const trustedDevices = devices.filter((d) => d.trusted);

  return (
    <div className="section-card">
      <div className="section-title">
        <span>Clipboard Activity & Sync</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{items.length} items</span>
          {items.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={onClearHistory}
              style={{ fontSize: '0.75rem', padding: '2px 8px' }}
              title="Clear local clipboard history list"
            >
              Clear History
            </button>
          )}
        </div>
      </div>

      {/* Quick Text Share Box */}
      <form onSubmit={handleSend} className="clipboard-input-form">
        <input
          type="text"
          className="text-input"
          placeholder="Type or paste text to share across LAN..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <select
          className="target-select"
          value={selectedTarget}
          onChange={(e) => setSelectedTarget(e.target.value)}
        >
          <option value="broadcast">All Trusted ({trustedDevices.length})</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} {d.trusted ? '(Trusted)' : '(Untrusted)'}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-sm" disabled={!inputText.trim()}>
          Share Text
        </button>
      </form>

      {/* Clipboard History List */}
      <div className="clipboard-list">
        {items.length === 0 ? (
          <div className="empty-state">No clipboard items synced yet. Copy text or files to share automatically.</div>
        ) : (
          items.map((item) => (
            <div key={item.id} className="clipboard-item">
              <div className="clipboard-content-group">
                <div className="clipboard-header-row">
                  <span className={`badge-tag ${item.type === 'file' ? 'badge-file' : ''}`}>
                    [{item.type.toUpperCase()}]
                  </span>
                  <span className="source-device">{item.sourceDeviceName}</span>
                  <span className="time-text">{formatTime(item.timestamp)}</span>
                </div>
                <div className="clipboard-body-text">
                  {item.type === 'file' ? (
                    <span>
                      📁 <strong>{item.name}</strong> ({formatBytes(item.size || 0)})
                    </span>
                  ) : (
                    item.content || 'Untitled item'
                  )}
                </div>
              </div>

              <div className="clipboard-actions">
                {item.type === 'text' && item.content && (
                  <button
                    className={`btn btn-sm ${copiedId === item.id ? 'btn-success' : 'btn-secondary'}`}
                    onClick={() => handleCopy(item)}
                  >
                    {copiedId === item.id ? '✓ Copied' : 'Copy'}
                  </button>
                )}
                {item.type === 'file' && item.path && (
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => onRequestFile(item.sourceDeviceId, item.path!)}
                    title="Download/Paste file from remote PC"
                  >
                    Download File
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
