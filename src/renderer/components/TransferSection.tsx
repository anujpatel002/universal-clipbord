import React from 'react';
import { Transfer } from '../../shared/types.js';

interface TransferSectionProps {
  transfers: Transfer[];
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onCancel: (transferId: string) => void;
}

export const TransferSection: React.FC<TransferSectionProps> = ({
  transfers,
  onPause,
  onResume,
  onCancel,
}) => {
  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatEta = (seconds?: number): string => {
    if (seconds === undefined || seconds <= 0) return '';
    if (seconds < 60) return `${seconds}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s remaining`;
  };

  const activeTransfers = transfers.filter((t) => t.status === 'transferring' || t.status === 'paused');

  return (
    <div className="section-card">
      <div className="section-title">
        <span>File & Folder Transfers ({transfers.length})</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {activeTransfers.length} active
        </span>
      </div>

      {transfers.length === 0 ? (
        <div className="empty-placeholder">
          <div className="empty-icon">🚀</div>
          <div>No active or past transfers.</div>
          <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
            Click "📥 Download" on any copied item or send a file directly.
          </div>
        </div>
      ) : (
        <div className="transfer-list">
          {transfers.map((tx) => {
            const percent = tx.size > 0 ? Math.min(100, Math.round((tx.transferred / tx.size) * 100)) : 100;
            const etaStr = formatEta(tx.eta);

            return (
              <div key={tx.id} className="transfer-card">
                <div className="transfer-top-row">
                  <div className="transfer-name">
                    <span>{tx.isFolder ? '📂' : '📄'}</span>
                    <span>{tx.fileName}</span>
                  </div>
                  <div className="btn-group">
                    <span className={`status-pill ${tx.status}`}>{tx.status}</span>
                    {tx.status === 'transferring' && (
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => onPause(tx.id)}
                        title="Pause transfer"
                      >
                        ⏸️ Pause
                      </button>
                    )}
                    {tx.status === 'paused' && (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => onResume(tx.id)}
                        title="Resume transfer"
                      >
                        ▶️ Resume
                      </button>
                    )}
                    {(tx.status === 'transferring' || tx.status === 'paused' || tx.status === 'pending') && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => onCancel(tx.id)}
                        title="Cancel transfer"
                      >
                        ✕ Cancel
                      </button>
                    )}
                  </div>
                </div>

                <div className="progress-track">
                  <div
                    className={`progress-fill ${tx.status}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>

                <div className="transfer-stats">
                  <span>
                    <strong>{formatBytes(tx.transferred)}</strong> of {formatBytes(tx.size)} ({percent}%)
                    {tx.speed && tx.status === 'transferring' ? ` • ⚡ ${formatBytes(tx.speed)}/s` : ''}
                    {etaStr && tx.status === 'transferring' ? ` • ⏳ ${etaStr}` : ''}
                  </span>
                  <span style={{ fontSize: '0.72rem' }}>
                    {tx.sourceDeviceName} ➔ {tx.destinationDeviceName}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
