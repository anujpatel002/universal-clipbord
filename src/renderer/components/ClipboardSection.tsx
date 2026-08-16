import React, { useState, useMemo } from 'react';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'text' | 'file'>('all');
  const [selectedTarget, setSelectedTarget] = useState<string>('broadcast');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const formatBytes = (bytes: number): string => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
      setTimeout(() => setCopiedId(null), 1800);
    }
  };

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const trustedDevices = devices.filter((d) => d.trusted);

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // Type filter
      if (filterType !== 'all' && item.type !== filterType) return false;
      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const textMatch = item.content?.toLowerCase().includes(q);
        const nameMatch = item.name?.toLowerCase().includes(q);
        const srcMatch = item.sourceDeviceName?.toLowerCase().includes(q);
        return textMatch || nameMatch || srcMatch;
      }
      return true;
    });
  }, [items, filterType, searchQuery]);

  return (
    <div className="section-card">
      <div className="section-title">
        <span>Clipboard Activity & Sync</span>
        <div className="btn-group">
          {items.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={onClearHistory}
              title="Clear all clipboard history entries"
            >
              🗑️ Clear History
            </button>
          )}
        </div>
      </div>

      {/* Quick Text Share Box */}
      <form onSubmit={handleSend} className="clipboard-input-form">
        <input
          type="text"
          className="text-input"
          placeholder="Type or paste text to broadcast instantly to all PCs..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <select
          className="target-select"
          value={selectedTarget}
          onChange={(e) => setSelectedTarget(e.target.value)}
        >
          <option value="broadcast">📢 All Trusted ({trustedDevices.length})</option>
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

      {/* Filter & Search Toolbar */}
      {items.length > 0 && (
        <div className="clipboard-toolbar">
          <input
            type="text"
            className="search-input"
            placeholder="🔍 Search clipboard history..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="btn-group">
            <button
              className={`btn btn-sm ${filterType === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterType('all')}
            >
              All
            </button>
            <button
              className={`btn btn-sm ${filterType === 'text' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterType('text')}
            >
              📝 Text
            </button>
            <button
              className={`btn btn-sm ${filterType === 'file' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterType('file')}
            >
              📁 Files/Folders
            </button>
          </div>
        </div>
      )}

      {/* Clipboard History List */}
      <div className="clipboard-list">
        {filteredItems.length === 0 ? (
          <div className="empty-placeholder">
            <div className="empty-icon">📋</div>
            <div>No clipboard items match your search.</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
              Copy text or files (<kbd>Ctrl</kbd> + <kbd>C</kbd>) on any paired PC to sync automatically.
            </div>
          </div>
        ) : (
          filteredItems.map((item) => (
            <div key={item.id} className="clipboard-card">
              <div className="clipboard-meta-group">
                <div className="clipboard-tags">
                  <span className={`tag-badge ${item.type === 'file' ? 'tag-file' : 'tag-text'}`}>
                    {item.isFolder ? 'FOLDER' : item.type.toUpperCase()}
                  </span>
                  <span className="source-text">From {item.sourceDeviceName}</span>
                  <span className="time-text">• {formatTime(item.timestamp)}</span>
                </div>
                <div className="clipboard-body-content">
                  {item.type === 'file' ? (
                    <span>
                      {item.isFolder ? '📂' : '📄'} <strong>{item.name}</strong> ({formatBytes(item.size || 0)})
                    </span>
                  ) : (
                    item.content
                  )}
                </div>
              </div>

              <div className="btn-group">
                {item.type === 'text' && item.content && (
                  <button
                    className={`btn btn-sm ${copiedId === item.id ? 'btn-success' : 'btn-secondary'}`}
                    onClick={() => handleCopy(item)}
                  >
                    {copiedId === item.id ? '✓ Copied!' : '📋 Copy'}
                  </button>
                )}
                {item.type === 'file' && item.path && (
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => onRequestFile(item.sourceDeviceId, item.path!)}
                    title="Download/Sync file to this PC"
                  >
                    📥 Download
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
