import React, { useEffect, useState, useRef } from 'react';
import {
  Device,
  LocalDeviceInfo,
  ClipboardItem,
  Transfer,
  PairingRequestItem,
  ScreenShareOfferPayload,
} from '../shared/types.js';
import { DeviceList } from './components/DeviceList.js';
import { ClipboardSection } from './components/ClipboardSection.js';
import { TransferSection } from './components/TransferSection.js';
import { PairingModal } from './components/PairingModal.js';
import { ScreenShareModal } from './components/ScreenShareModal.js';
import { ScreenViewer } from './components/ScreenViewer.js';
import { WebRTCManager } from './webrtc.js';

type TabType = 'devices' | 'clipboard' | 'transfers' | 'screenshare' | 'settings';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('devices');
  const [localInfo, setLocalInfo] = useState<LocalDeviceInfo | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [clipboardItems, setClipboardItems] = useState<ClipboardItem[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [pendingPairRequests, setPendingPairRequests] = useState<PairingRequestItem[]>([]);

  // Screen Share state
  const [showShareModal, setShowShareModal] = useState<boolean>(false);
  const [activeOutgoingShare, setActiveOutgoingShare] = useState<{
    streamId: string;
    targetDeviceId: string;
    sourceName: string;
  } | null>(null);
  const [incomingOffer, setIncomingOffer] = useState<{
    sourceDeviceId: string;
    sourceDeviceName: string;
    payload: ScreenShareOfferPayload;
  } | null>(null);
  const [activeViewerStream, setActiveViewerStream] = useState<{
    stream: MediaStream | null;
    peerName: string;
    sourceName: string;
    quality: string;
    streamId: string;
    sourceDeviceId: string;
  } | null>(null);

  const webrtcRef = useRef<WebRTCManager>(new WebRTCManager());

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

    // Screen Share Signaling Listeners
    const unsubOffer = window.multiclip?.onScreenShareOffer((data) => {
      setIncomingOffer(data);
    });

    const unsubAnswer = window.multiclip?.onScreenShareAnswer((data) => {
      webrtcRef.current.handleAnswer(data.payload);
    });

    const unsubIce = window.multiclip?.onScreenShareIce((data) => {
      webrtcRef.current.handleIceCandidate(data.payload);
    });

    const unsubStop = window.multiclip?.onScreenShareStop((data) => {
      if (activeViewerStream?.streamId === data.payload.streamId) {
        setActiveViewerStream(null);
      }
      if (activeOutgoingShare?.streamId === data.payload.streamId) {
        webrtcRef.current.stopSession(data.payload.streamId, false);
        setActiveOutgoingShare(null);
      }
    });

    return () => {
      unsubDevices?.();
      unsubClipboard?.();
      unsubTransfers?.();
      unsubPairing?.();
      unsubOffer?.();
      unsubAnswer?.();
      unsubIce?.();
      unsubStop?.();
    };
  }, [activeViewerStream, activeOutgoingShare]);

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

  // --- Screen Share Handlers ---

  const handleStartScreenShare = async (
    targetDeviceId: string,
    sourceId: string,
    sourceName: string,
    quality: '720p' | '1080p' | '4k'
  ) => {
    try {
      setShowShareModal(false);
      const stream = await webrtcRef.current.getScreenMediaStream(sourceId, quality);
      const streamId = await webrtcRef.current.createOffer(targetDeviceId, stream, sourceName, quality);
      setActiveOutgoingShare({ streamId, targetDeviceId, sourceName });
    } catch (err) {
      alert(`Could not start screen capture: ${(err as Error).message}`);
    }
  };

  const handleAcceptScreenShare = async () => {
    if (!incomingOffer) return;
    const offer = incomingOffer;
    setIncomingOffer(null);

    // Immediately render viewer in connecting state with zero lag
    setActiveViewerStream({
      stream: null,
      peerName: offer.sourceDeviceName,
      sourceName: offer.payload.sourceName,
      quality: offer.payload.quality,
      streamId: offer.payload.streamId,
      sourceDeviceId: offer.sourceDeviceId,
    });

    try {
      await webrtcRef.current.handleOffer(offer.sourceDeviceId, offer.payload, (remoteStream) => {
        setActiveViewerStream((prev) => (prev ? { ...prev, stream: remoteStream } : null));
      });
    } catch (err) {
      console.log('[WARN] Error accepting screen share:', err);
    }
  };

  const handleRejectScreenShare = () => {
    if (!incomingOffer) return;
    window.multiclip?.sendScreenShareStop(incomingOffer.sourceDeviceId, {
      streamId: incomingOffer.payload.streamId,
    });
    setIncomingOffer(null);
  };

  const handleCloseViewer = () => {
    if (!activeViewerStream) return;
    webrtcRef.current.stopSession(activeViewerStream.streamId, true, activeViewerStream.sourceDeviceId);
    setActiveViewerStream(null);
  };

  const handleStopOutgoingShare = () => {
    if (!activeOutgoingShare) return;
    webrtcRef.current.stopSession(activeOutgoingShare.streamId, true, activeOutgoingShare.targetDeviceId);
    setActiveOutgoingShare(null);
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
            className={`nav-tab ${activeTab === 'screenshare' ? 'active' : ''}`}
            onClick={() => setActiveTab('screenshare')}
          >
            🖥️ Screen Share
          </button>
          <button
            className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            ⚙️ Info
          </button>
        </nav>
      </header>

      {/* Incoming Pairing Modal */}
      {pendingPairRequests.map((req) => (
        <PairingModal
          key={req.deviceId}
          request={req}
          onAccept={handleAcceptPair}
          onReject={handleRejectPair}
        />
      ))}

      {/* Incoming Screen Share Banner */}
      {incomingOffer && (
        <div className="pairing-banner" style={{ background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(16, 185, 129, 0.25))' }}>
          <div className="pairing-banner-info">
            <div className="pairing-icon">🖥️</div>
            <div>
              <strong>{incomingOffer.sourceDeviceName}</strong> is inviting you to view their screen: <em>{incomingOffer.payload.sourceName}</em> ({incomingOffer.payload.quality})
              <div className="pairing-subtext">Direct P2P LAN 60FPS Video Stream</div>
            </div>
          </div>
          <div className="btn-group">
            <button className="btn btn-sm btn-success" onClick={handleAcceptScreenShare}>
              ✓ Accept & View
            </button>
            <button className="btn btn-sm btn-secondary" onClick={handleRejectScreenShare}>
              ✕ Decline
            </button>
          </div>
        </div>
      )}

      {/* Active Outgoing Screen Share Indicator */}
      {activeOutgoingShare && (
        <div className="pairing-banner" style={{ background: 'rgba(59, 130, 246, 0.2)', borderColor: 'var(--accent)' }}>
          <div className="pairing-banner-info">
            <div className="status-dot" />
            <div>
              <strong>Currently Broadcasting Screen:</strong> {activeOutgoingShare.sourceName}
              <div className="pairing-subtext">Live 60 FPS hardware accelerated stream</div>
            </div>
          </div>
          <button className="btn btn-sm btn-danger" onClick={handleStopOutgoingShare}>
            ⏹️ Stop Sharing
          </button>
        </div>
      )}

      {/* Fullscreen Remote Screen Viewer */}
      {activeViewerStream && (
        <ScreenViewer
          stream={activeViewerStream.stream}
          peerName={activeViewerStream.peerName}
          sourceName={activeViewerStream.sourceName}
          quality={activeViewerStream.quality}
          onClose={handleCloseViewer}
        />
      )}

      {/* Screen Share Source Picker Modal */}
      {showShareModal && (
        <ScreenShareModal
          devices={devices}
          onStartShare={handleStartScreenShare}
          onClose={() => setShowShareModal(false)}
        />
      )}

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
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setShowShareModal(true)}
            disabled={onlineDevicesCount === 0}
            title="Share screen or application window with another PC"
          >
            🖥️ Share Screen
          </button>
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

        {activeTab === 'screenshare' && (
          <div className="section-card">
            <div className="section-title">
              <span>🖥️ LAN Screen & Window Sharing (60 FPS)</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem 0' }}>
              <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                <h4 style={{ marginBottom: '0.4rem', color: 'var(--text-main)' }}>Ultra-Low Latency Zero-Cloud Streaming</h4>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                  Stream full displays or individual application windows directly between PCs on your local Wi-Fi / Ethernet at up to 4K 60 FPS with hardware acceleration. Zero internet bandwidth used.
                </p>
                <div style={{ marginTop: '0.85rem' }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => setShowShareModal(true)}
                    disabled={onlineDevicesCount === 0}
                  >
                    🖥️ Choose Screen & Start Sharing
                  </button>
                </div>
              </div>

              {activeOutgoingShare && (
                <div style={{ background: 'rgba(59, 130, 246, 0.1)', padding: '1rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--accent)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>Active Broadcast:</strong> {activeOutgoingShare.sourceName}
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Broadcasting over local LAN</div>
                    </div>
                    <button className="btn btn-sm btn-danger" onClick={handleStopOutgoingShare}>
                      Stop Stream
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
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
                <span className="settings-value">MultiClip v{localInfo?.version || '1.0.0'} (P2P + WebRTC + SQLite)</span>
              </div>
              <div className="settings-item">
                <span className="settings-label">Discovery Engines</span>
                <span className="settings-value">TCP Subnet Sweeper + mDNS + UDP Broadcast</span>
              </div>
              <div className="settings-item">
                <span className="settings-label">Screen Share Streaming</span>
                <span className="settings-value">Hardware H.264/VP9 WebRTC over Local LAN (60 FPS)</span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
