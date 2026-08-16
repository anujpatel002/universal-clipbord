import React, { useEffect, useState } from 'react';
import { Device, ScreenSource } from '../../shared/types.js';

interface ScreenShareModalProps {
  devices: Device[];
  onStartShare: (targetDeviceId: string, sourceId: string, sourceName: string, quality: '720p' | '1080p' | '4k') => void;
  onClose: () => void;
}

export const ScreenShareModal: React.FC<ScreenShareModalProps> = ({
  devices,
  onStartShare,
  onClose,
}) => {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [quality, setQuality] = useState<'720p' | '1080p' | '4k'>('1080p');
  const [loading, setLoading] = useState<boolean>(true);

  const trustedDevices = devices.filter((d) => d.trusted && d.status === 'online');

  useEffect(() => {
    window.multiclip?.getScreenSources().then((srcs) => {
      setSources(srcs);
      if (srcs.length > 0) {
        setSelectedSourceId(srcs[0].id);
      }
      setLoading(false);
    });

    if (trustedDevices.length > 0) {
      setSelectedDeviceId(trustedDevices[0].id);
    }
  }, [devices]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSourceId || !selectedDeviceId) return;

    const source = sources.find((s) => s.id === selectedSourceId);
    onStartShare(selectedDeviceId, selectedSourceId, source?.name || 'Screen', quality);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '680px' }}>
        <div className="modal-header">
          <div className="modal-title">
            <span>🖥️ Share Screen with LAN Peer</span>
          </div>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Target Device & Quality Selector */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem' }}>
                Target Device:
              </label>
              <select
                className="target-select"
                style={{ width: '100%', padding: '0.45rem' }}
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
              >
                {trustedDevices.length === 0 ? (
                  <option value="">No paired online PCs found</option>
                ) : (
                  trustedDevices.map((d) => (
                    <option key={d.id} value={d.id}>
                      💻 {d.name} ({d.ip})
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem' }}>
                Quality & Frame Rate:
              </label>
              <select
                className="target-select"
                style={{ width: '100%', padding: '0.45rem' }}
                value={quality}
                onChange={(e) => setQuality(e.target.value as any)}
              >
                <option value="1080p">🚀 1080p @ 60 FPS (High Quality)</option>
                <option value="720p">⚡ 720p @ 30 FPS (Low Latency)</option>
                <option value="4k">🌟 4K / Native @ 60 FPS (Ultra Crisp)</option>
              </select>
            </div>
          </div>

          {/* Screen / Window Selection Grid */}
          <div>
            <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.5rem' }}>
              Select Screen or Application Window to Share:
            </label>

            {loading ? (
              <div className="empty-placeholder">Loading available displays and windows...</div>
            ) : (
              <div className="screen-source-grid">
                {sources.map((src) => (
                  <div
                    key={src.id}
                    className={`screen-source-card ${selectedSourceId === src.id ? 'selected' : ''}`}
                    onClick={() => setSelectedSourceId(src.id)}
                  >
                    <div className="source-thumbnail-box">
                      <img src={src.thumbnail} alt={src.name} className="source-thumbnail" />
                    </div>
                    <div className="source-name-row">
                      {src.appIcon && <img src={src.appIcon} alt="" style={{ width: 16, height: 16 }} />}
                      <span className="source-name" title={src.name}>{src.name}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!selectedSourceId || !selectedDeviceId}
            >
              🚀 Start Live Screen Share
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
