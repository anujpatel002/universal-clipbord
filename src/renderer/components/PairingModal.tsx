import React from 'react';
import { PairingRequestItem } from '../../shared/types.js';

interface PairingModalProps {
  request: PairingRequestItem;
  onAccept: (deviceId: string) => void;
  onReject: (deviceId: string) => void;
}

export const PairingModal: React.FC<PairingModalProps> = ({ request, onAccept, onReject }) => {
  return (
    <div className="pairing-banner">
      <div className="pairing-banner-info">
        <span className="pairing-icon">🔐</span>
        <div>
          <strong>New Device Pairing Request</strong>
          <div className="pairing-subtext">
            <strong>{request.deviceName}</strong> ({request.ip}) wants to pair and share clipboards.
          </div>
        </div>
      </div>

      <div className="pairing-banner-actions">
        <button className="btn btn-sm btn-success" onClick={() => onAccept(request.deviceId)}>
          Accept & Trust
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => onReject(request.deviceId)}>
          Reject
        </button>
      </div>
    </div>
  );
};
