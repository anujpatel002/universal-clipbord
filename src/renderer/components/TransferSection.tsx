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
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="section-card">
      <div className="section-title">
        <span>Large File Transfers (Resumable Streaming)</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {transfers.filter((t) => t.status === 'transferring').length} active
        </span>
      </div>

      <div className="transfer-list">
        {transfers.length === 0 ? (
          <div className="empty-state">No active or past transfers. Drop a file on a device to start.</div>
        ) : (
          transfers.map((t) => {
            const percent = t.size > 0 ? Math.min(100, Math.round((t.transferred / t.size) * 100)) : 0;
            const isOutbound = t.sourceDeviceId === 'local' || !t.sourceDeviceName.includes('Remote');

            return (
              <div key={t.id} className={`transfer-item status-${t.status}`}>
                <div className="transfer-header">
                  <div className="transfer-name-box">
                    <span className="file-icon">📄</span>
                    <strong>{t.fileName}</strong>
                    <span className={`status-pill ${t.status}`}>{t.status}</span>
                  </div>

                  <div className="transfer-btn-group">
                    {t.status === 'transferring' && (
                      <button className="btn btn-sm btn-secondary" onClick={() => onPause(t.id)}>
                        Pause
                      </button>
                    )}
                    {t.status === 'paused' && (
                      <button className="btn btn-sm btn-secondary" onClick={() => onResume(t.id)}>
                        Resume
                      </button>
                    )}
                    {(t.status === 'transferring' || t.status === 'paused' || t.status === 'pending') && (
                      <button className="btn btn-sm btn-danger" onClick={() => onCancel(t.id)}>
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                <div className="transfer-stats-row">
                  <span>
                    {formatBytes(t.transferred)} / {formatBytes(t.size)} ({percent}%)
                  </span>
                  {t.speed && t.status === 'transferring' && (
                    <span className="speed-text">{formatBytes(t.speed)}/s</span>
                  )}
                  <span className="peer-text">
                    {isOutbound ? `To: ${t.destinationDeviceName}` : `From: ${t.sourceDeviceName}`}
                  </span>
                </div>

                <div className="progress-bar-bg">
                  <div
                    className={`progress-bar-fill ${t.status}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
