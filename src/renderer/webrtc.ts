import {
  ScreenShareOfferPayload,
  ScreenShareAnswerPayload,
  ScreenShareIcePayload,
} from '../shared/types.js';

export class WebRTCManager {
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private localStreams: Map<string, MediaStream> = new Map();

  /**
   * Captures screen or window stream using desktopCapturer media constraints
   */
  public async getScreenMediaStream(
    sourceId: string,
    quality: '720p' | '1080p' | '4k'
  ): Promise<MediaStream> {
    const width = quality === '4k' ? 3840 : (quality === '720p' ? 1280 : 1920);
    const height = quality === '4k' ? 2160 : (quality === '720p' ? 720 : 1080);
    const fps = quality === '720p' ? 30 : 60;

    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: width,
          minHeight: 720,
          maxHeight: height,
          minFrameRate: 30,
          maxFrameRate: fps,
        },
      },
    };

    return await navigator.mediaDevices.getUserMedia(constraints as any);
  }

  /**
   * Sender: Creates an RTCPeerConnection, adds local screen tracks, and creates SDP Offer
   */
  public async createOffer(
    targetDeviceId: string,
    stream: MediaStream,
    sourceName: string,
    quality: '720p' | '1080p' | '4k',
    streamId: string = crypto.randomUUID()
  ): Promise<string> {
    // Pure LAN connection: no external STUN needed because both PCs are on same local subnet
    const pc = new RTCPeerConnection({
      iceServers: [],
    });

    this.peerConnections.set(streamId, pc);
    this.localStreams.set(streamId, stream);

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        window.multiclip?.sendScreenShareIce(targetDeviceId, {
          streamId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    const offer = await pc.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false,
    });

    await pc.setLocalDescription(offer);

    await window.multiclip?.sendScreenShareOffer(targetDeviceId, {
      streamId,
      sdp: pc.localDescription,
      sourceName,
      quality,
    });

    return streamId;
  }

  /**
   * Receiver: Handles incoming offer, creates RTCPeerConnection, and sends SDP Answer
   */
  public async handleOffer(
    sourceDeviceId: string,
    payload: ScreenShareOfferPayload,
    onRemoteStream: (stream: MediaStream) => void
  ): Promise<void> {
    const { streamId, sdp } = payload;

    const pc = new RTCPeerConnection({
      iceServers: [],
    });

    this.peerConnections.set(streamId, pc);

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        onRemoteStream(event.streams[0]);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        window.multiclip?.sendScreenShareIce(sourceDeviceId, {
          streamId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await window.multiclip?.sendScreenShareAnswer(sourceDeviceId, {
      streamId,
      sdp: pc.localDescription,
    });
  }

  /**
   * Sender: Handles incoming SDP answer from receiver
   */
  public async handleAnswer(payload: ScreenShareAnswerPayload): Promise<void> {
    const pc = this.peerConnections.get(payload.streamId);
    if (pc && pc.signalingState !== 'stable') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    }
  }

  /**
   * Handles incoming ICE candidate
   */
  public async handleIceCandidate(payload: ScreenShareIcePayload): Promise<void> {
    const pc = this.peerConnections.get(payload.streamId);
    if (pc && payload.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (err) {
        console.log('[WARN] ICE candidate error:', err);
      }
    }
  }

  /**
   * Stops and closes an active screen share session
   */
  public stopSession(streamId: string, notifyPeer: boolean = true, targetDeviceId?: string): void {
    const localStream = this.localStreams.get(streamId);
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      this.localStreams.delete(streamId);
    }

    const pc = this.peerConnections.get(streamId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(streamId);
    }

    if (notifyPeer && targetDeviceId) {
      window.multiclip?.sendScreenShareStop(targetDeviceId, { streamId });
    }
  }
}
