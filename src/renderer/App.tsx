import React, { useEffect, useState } from 'react';
import {
  Device,
  LocalDeviceInfo,
  ClipboardItem,
  Transfer,
  PairingRequestItem,
} from '../shared/types.js';
import { DeviceList } from './components/DeviceList.js';
import { ClipboardSection } from './components/ClipboardSection.js';
import { TransferSection } from './components/TransferSection.js';
import { PairingModal } from './components/PairingModal.js';

export const App: React.FC = () => {
  const [localInfo, setLocalInfo] = useState<LocalDeviceInfo | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [clipboardItems, setClipboardItems] = useState<ClipboardItem[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [pendingPairRequests, setPendingPairRequests] = useState<PairingRequestItem[]>([]);

  useEffect(() => {
    // Initial fetch
    window.multiclip?.getLocalInfo().then(setLocalInfo);
    window.multiclip?.getDevices().then(setDevices);
    window.multiclip?.getClipboardHistory().then(setClipboardItems);
    window.multiclip?.getTransfers().then(setTransfers);

    // Event listeners
    const unsubDevices = window.multiclip?.onDeviceUpdate((updated) => {
      setDevices(updated);
    });

    const unsubClipboard = window.multiclip?.onClipboardUpdate((item) => {
      setClipboardItems((prev) => [item, ...prev.filter((i) => i.id !== item.id)]);
    });

    const unsubTransfers = window.multiclip?.onTransferUpdate((transfer) => {
      setTransfers((prev) => {
        const index = prev.findIndex((t) => t.id === transfer.id);
        if (index >= 0) {
          const next = [...prev];
          next[index] = transfer;
          return next;
        }
        return [transfer, ...prev];
      });
    });

    const unsubPairing = window.multiclip?.onPairingRequest((req) => {
      setPendingPairRequests((prev) => [...prev.filter((r) => r.deviceId !== req.deviceId), req]);
    });

    return () => {
      unsubDevices?.();
      unsubClipboard?.();
      unsubTransfers?.();
      unsubPairing?.();
    };
  }, []);

  const handlePair = async (deviceId: string) => {
    await window.multiclip?.pairDevice(deviceId);
  };

  const handleUnpair = async (deviceId: string) => {
    await window.multiclip?.unpairDevice(deviceId);
  };

  const handleAcceptPair = async (deviceId: string) => {
    await window.multiclip?.respondToPairRequest(deviceId, true);
    setPendingPairRequests((prev) => prev.filter((r) => r.deviceId !== deviceId));
  };

  const handleRejectPair = async (deviceId: string) => {
    await window.multiclip?.respondToPairRequest(deviceId, false);
    setPendingPairRequests((prev) => prev.filter((r) => r.deviceId !== deviceId));
  };

  const handleBroadcastText = async (text: string) => {
    await window.multiclip?.broadcastClipboardText(text);
  };

  const handleSendToDevice = async (targetDeviceId: string, item: ClipboardItem) => {
    await window.multiclip?.sendClipboardToDevice(targetDeviceId, item);
  };

  const handleCopyToClipboard = async (text: string) => {
    await window.multiclip?.copyToLocalClipboard(text);
  };

  const handleSendFile = async (deviceId: string, filePath?: string) => {
    let targetPath = filePath;
    if (!targetPath) {
      targetPath = (await window.multiclip?.selectFileToSend()) || undefined;
    }
    if (targetPath) {
      await window.multiclip?.initiateFileTransfer(deviceId, targetPath);
    }
  };

  const handleRequestFile = async (sourceDeviceId: string, remoteFilePath: string) => {
    await window.multiclip?.requestFileFromPeer(sourceDeviceId, remoteFilePath);
  };

  const handlePauseTransfer = async (transferId: string) => {
    await window.multiclip?.pauseTransfer(transferId);
  };

  const handleResumeTransfer = async (transferId: string) => {
    await window.multiclip?.resumeTransfer(transferId);
  };

  const handleCancelTransfer = async (transferId: string) => {
    await window.multiclip?.cancelTransfer(transferId);
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          MultiClip
          <span className="logo-badge">P2P Encrypted</span>
        </div>
      </header>

      {/* Pending Incoming Pairing Requests */}
      {pendingPairRequests.map((req) => (
        <PairingModal
          key={req.deviceId}
          request={req}
          onAccept={handleAcceptPair}
          onReject={handleRejectPair}
        />
      ))}

      <div className="local-pc-card">
        <div className="local-pc-info">
          <h2>This PC</h2>
          <div className="local-pc-name">{localInfo?.name || 'Loading...'}</div>
          <div className="local-pc-ip">
            {localInfo?.ip}:{localInfo?.port} &bull; ID: {localInfo?.id.slice(0, 8)}
          </div>
        </div>
      </div>

      <DeviceList
        devices={devices}
        onPair={handlePair}
        onUnpair={handleUnpair}
        onSendFile={handleSendFile}
      />

      <ClipboardSection
        items={clipboardItems}
        devices={devices}
        onBroadcastText={handleBroadcastText}
        onSendToDevice={handleSendToDevice}
        onCopyToClipboard={handleCopyToClipboard}
        onRequestFile={handleRequestFile}
      />

      <TransferSection
        transfers={transfers}
        onPause={handlePauseTransfer}
        onResume={handleResumeTransfer}
        onCancel={handleCancelTransfer}
      />
    </div>
  );
};
