import React, { useEffect, useRef, useState } from 'react';

interface ScreenViewerProps {
  stream: MediaStream | null;
  peerName: string;
  sourceName: string;
  quality: string;
  onClose: () => void;
}

export const ScreenViewer: React.FC<ScreenViewerProps> = ({
  stream,
  peerName,
  sourceName,
  quality,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch((err) => {
          console.log('[WARN] Video auto-play error:', err);
        });
    }

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [stream]);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const togglePip = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.log('[WARN] PiP error:', err);
    }
  };

  return (
    <div className="screen-viewer-overlay" ref={containerRef}>
      {/* Floating control bar */}
      <div className="screen-viewer-header">
        <div className="viewer-info-group">
          <div className="status-dot" />
          <span className="viewer-peer-name">
            <strong>{peerName}</strong> ({sourceName})
          </span>
          <span className="viewer-badge">{quality.toUpperCase()}</span>
          <span className="viewer-badge-fps">⚡ Low-Latency Direct LAN Stream</span>
        </div>

        <div className="btn-group">
          <button
            className="btn btn-sm btn-secondary"
            onClick={togglePip}
            title="Picture-in-Picture mode"
          >
            🖼️ PiP
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={toggleFullscreen}
            title="Toggle Fullscreen"
          >
            {isFullscreen ? 'Exit Fullscreen' : '⛶ Fullscreen'}
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={onClose}
            title="Disconnect screen share"
          >
            ⏹️ End Screen Share
          </button>
        </div>
      </div>

      {/* Video stream canvas */}
      <div className="video-container">
        {!stream || !isPlaying ? (
          <div className="empty-placeholder" style={{ color: '#fff' }}>
            <div className="empty-icon">📡</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>Connecting to {peerName}...</div>
            <div style={{ fontSize: '0.85rem', opacity: 0.8 }}>
              Establishing direct 60 FPS hardware-accelerated video stream
            </div>
          </div>
        ) : null}

        <video
          ref={videoRef}
          className="screen-video-player"
          style={{ display: stream ? 'block' : 'none' }}
          autoPlay
          playsInline
          muted
        />
      </div>
    </div>
  );
};
