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

type TabType = 'devices' | 'clipboard' | 'transfers' | 'settings';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('devices');
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
      setActiveTab('transfers');
    }
  };

  const handleRequestFile = async (sourceDeviceId: string, remoteFilePath: string) => {
    await window.multiclip?.requestFileFromPeer(sourceDeviceId, remoteFilePath);
    setActiveTab('transfers');
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

  const handleClearHistory = async () => {
    await window.multiclip?.clearClipboardHistory();
    setClipboardItems([]);
  };

  const onlineDevicesCount = devices.filter((d) => d.status === 'online').length;
  const activeTransfersCount = transfers.filter((t) => t.status === 'transferring' || t.status === 'paused').length;

  return (
    <div className="app-container">
      {/* App Header */}
      <header className="app-header">
        <div className="header-left">
          <div className="logo-group">
            <span className="logo-icon">📋</span>
            <span className="logo-title">MultiClip</span>
          </div>
          <div className="status-badge">
            <div className="status-dot" />
            <span>{onlineDevicesCount > 0 ? `${onlineDevicesCount} Peer${onlineDevicesCount > 1 ? 's' : ''} Online` : 'Ready on LAN'}</span>
          </div>
        </div>

        {/* Tab Navigation */}
        <nav className="nav-tabs">
          <button
            className={`nav-tab ${activeTab === 'devices' ? 'active' : ''}`}
            onClick={() => setActiveTab('devices')}
          >
            💻 Devices
            {onlineDevicesCount > 0 && <span className="tab-badge">{onlineDevicesCount}</span>}
          </button>
          <button
            className={`nav-tab ${activeTab === 'clipboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('clipboard')}
          >
            📋 Clipboard
            {clipboardItems.length > 0 && <span className="tab-badge">{clipboardItems.length}</span>}
          </button>
          <button
            className={`nav-tab ${activeTab === 'transfers' ? 'active' : ''}`}
            onClick={() => setActiveTab('transfers')}
          >
            🚀 Transfers
            {activeTransfersCount > 0 && <span className="tab-badge" style={{ background: 'var(--accent)' }}>{activeTransfersCount}</span>}
          </button>
          <button
            className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            ⚙️ Info
          </button>
        </nav>
      </header>

      {/* Pending Incoming Pairing Modal / Notification */}
      {pendingPairRequests.map((req) => (
        <PairingModal
          key={req.deviceId}
          request={req}
          onAccept={handleAcceptPair}
          onReject={handleRejectPair}
        />
      ))}

      {/* Local PC Status Card */}
      <div className="local-pc-card">
        <div className="local-pc-left">
          <div className="device-avatar">🖥️</div>
          <div className="local-pc-details">
            <h3>{localInfo?.name || 'This Computer'} (Local)</h3>
            <div className="local-pc-ip">
              IP: {localInfo?.ip}:{localInfo?.port} &bull; Device ID: {localInfo?.id.slice(0, 8)}
            </div>
          </div>
        </div>
        <div className="btn-group">
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Auto-Sync: <strong style={{ color: 'var(--success)' }}>Active</strong>
          </span>
        </div>
      </div>

      {/* Main Tab Content */}
      <main className="main-content-area">
        {activeTab === 'devices' && (
          <>
            <DeviceList
              devices={devices}
              onPair={handlePair}
              onUnpair={handleUnpair}
              onSendFile={handleSendFile}
            />
            <ClipboardSection
              items={clipboardItems.slice(0, 5)}
              devices={devices}
              onBroadcastText={handleBroadcastText}
              onSendToDevice={handleSendToDevice}
              onCopyToClipboard={handleCopyToClipboard}
              onRequestFile={handleRequestFile}
              onClearHistory={handleClearHistory}
            />
          </>
        )}

        {activeTab === 'clipboard' && (
          <ClipboardSection
            items={clipboardItems}
            devices={devices}
            onBroadcastText={handleBroadcastText}
            onSendToDevice={handleSendToDevice}
            onCopyToClipboard={handleCopyToClipboard}
            onRequestFile={handleRequestFile}
            onClearHistory={handleClearHistory}
          />
        )}

        {activeTab === 'transfers' && (
          <TransferSection
            transfers={transfers}
            onPause={handlePauseTransfer}
            onResume={handleResumeTransfer}
            onCancel={handleCancelTransfer}
          />
        )}

        {activeTab === 'settings' && (
          <div className="section-card">
            <div className="section-title">
              <span>MultiClip Architecture & Network Diagnostics</span>
            </div>
            <div className="settings-grid">
              <div className="settings-item">
                <span className="settings-label">Device Name</span>
                <span className="settings-value">{localInfo?.name || 'Local'}</span>
              </div>
              <div className="settings-item">
                <span className="settings-label">Primary IP Address</span>
                <span className="settings-value">{localInfo?.ip}:{localInfo?.port}</span>
              </div>
              <div className="settings-item">
                <span className="settings-label">P2P Device UUID</span>
                <span className="settings-value">{localInfo?.id}</span>
              </div>
              <div className="settings-item">
                <span className="settings-label">Version</span>
                <span className="settings-value">MultiClip v{localInfo?.version || '1.0.0'} (P2P + SQLite)</span>
              </div>
              <div className="settings-item">
                <span className="settings-label">Discovery Engines</span>
                <span className="settings-value">TCP Subnet Sweeper + mDNS + UDP Broadcast</span>
              </div>
              <div className="settings-item">
                <span className="settings-label">Security & Encryption</span>
                <span className="settings-value">Ed25519 Signatures + AES-256-GCM Trust</span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
