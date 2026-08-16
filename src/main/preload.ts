import { contextBridge, ipcRenderer } from 'electron';
import {
  Device,
  LocalDeviceInfo,
  ClipboardItem,
  Transfer,
  PairingRequestItem,
  ScreenSource,
  ScreenShareOfferPayload,
  ScreenShareAnswerPayload,
  ScreenShareIcePayload,
  ScreenShareStopPayload,
} from '../shared/types.js';

contextBridge.exposeInMainWorld('multiclip', {
  getLocalInfo: (): Promise<LocalDeviceInfo> => ipcRenderer.invoke('get-local-info'),
  getDevices: (): Promise<Device[]> => ipcRenderer.invoke('get-devices'),
  getClipboardHistory: (): Promise<ClipboardItem[]> => ipcRenderer.invoke('get-clipboard-history'),
  getTransfers: (): Promise<Transfer[]> => ipcRenderer.invoke('get-transfers'),
  pairDevice: (deviceId: string): Promise<boolean> => ipcRenderer.invoke('pair-device', deviceId),
  unpairDevice: (deviceId: string): Promise<boolean> => ipcRenderer.invoke('unpair-device', deviceId),
  respondToPairRequest: (deviceId: string, accept: boolean): Promise<void> =>
    ipcRenderer.invoke('respond-pair-request', deviceId, accept),
  copyToLocalClipboard: (text: string): Promise<void> => ipcRenderer.invoke('copy-to-local-clipboard', text),
  broadcastClipboardText: (text: string): Promise<ClipboardItem> => ipcRenderer.invoke('broadcast-clipboard-text', text),
  sendClipboardToDevice: (targetDeviceId: string, item: ClipboardItem): Promise<void> =>
    ipcRenderer.invoke('send-clipboard', targetDeviceId, item),
  initiateFileTransfer: (targetDeviceId: string, filePath: string): Promise<Transfer> =>
    ipcRenderer.invoke('initiate-file-transfer', targetDeviceId, filePath),
  requestFileFromPeer: (sourceDeviceId: string, remoteFilePath: string): Promise<void> =>
    ipcRenderer.invoke('request-file-from-peer', sourceDeviceId, remoteFilePath),
  selectFileToSend: (): Promise<string | null> => ipcRenderer.invoke('select-file-to-send'),
  pauseTransfer: (transferId: string): Promise<void> => ipcRenderer.invoke('pause-transfer', transferId),
  resumeTransfer: (transferId: string): Promise<void> => ipcRenderer.invoke('resume-transfer', transferId),
  cancelTransfer: (transferId: string): Promise<void> => ipcRenderer.invoke('cancel-transfer', transferId),
  connectToIp: (ip: string, port?: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('connect-to-ip', ip, port),
  rescanPeers: (): Promise<void> => ipcRenderer.invoke('rescan-peers'),
  clearClipboardHistory: (): Promise<void> => ipcRenderer.invoke('clear-clipboard-history'),

  // Screen Share APIs
  getScreenSources: (): Promise<ScreenSource[]> => ipcRenderer.invoke('get-screen-sources'),
  sendScreenShareOffer: (targetDeviceId: string, payload: ScreenShareOfferPayload): Promise<void> =>
    ipcRenderer.invoke('send-screenshare-offer', targetDeviceId, payload),
  sendScreenShareAnswer: (targetDeviceId: string, payload: ScreenShareAnswerPayload): Promise<void> =>
    ipcRenderer.invoke('send-screenshare-answer', targetDeviceId, payload),
  sendScreenShareIce: (targetDeviceId: string, payload: ScreenShareIcePayload): Promise<void> =>
    ipcRenderer.invoke('send-screenshare-ice', targetDeviceId, payload),
  sendScreenShareStop: (targetDeviceId: string, payload: ScreenShareStopPayload): Promise<void> =>
    ipcRenderer.invoke('send-screenshare-stop', targetDeviceId, payload),

  onDeviceUpdate: (callback: (devices: Device[]) => void) => {
    const handler = (_: unknown, devices: Device[]) => callback(devices);
    ipcRenderer.on('devices-updated', handler);
    return () => ipcRenderer.removeListener('devices-updated', handler);
  },
  onClipboardUpdate: (callback: (item: ClipboardItem) => void) => {
    const handler = (_: unknown, item: ClipboardItem) => callback(item);
    ipcRenderer.on('clipboard-updated', handler);
    return () => ipcRenderer.removeListener('clipboard-updated', handler);
  },
  onTransferUpdate: (callback: (transfer: Transfer) => void) => {
    const handler = (_: unknown, transfer: Transfer) => callback(transfer);
    ipcRenderer.on('transfer-updated', handler);
    return () => ipcRenderer.removeListener('transfer-updated', handler);
  },
  onPairingRequest: (callback: (request: PairingRequestItem) => void) => {
    const handler = (_: unknown, req: PairingRequestItem) => callback(req);
    ipcRenderer.on('pairing-requested', handler);
    return () => ipcRenderer.removeListener('pairing-requested', handler);
  },

  onScreenShareOffer: (callback: (data: { sourceDeviceId: string; sourceDeviceName: string; payload: ScreenShareOfferPayload }) => void) => {
    const handler = (_: unknown, data: any) => callback(data);
    ipcRenderer.on('screenshare-offer', handler);
    return () => ipcRenderer.removeListener('screenshare-offer', handler);
  },
  onScreenShareAnswer: (callback: (data: { sourceDeviceId: string; payload: ScreenShareAnswerPayload }) => void) => {
    const handler = (_: unknown, data: any) => callback(data);
    ipcRenderer.on('screenshare-answer', handler);
    return () => ipcRenderer.removeListener('screenshare-answer', handler);
  },
  onScreenShareIce: (callback: (data: { sourceDeviceId: string; payload: ScreenShareIcePayload }) => void) => {
    const handler = (_: unknown, data: any) => callback(data);
    ipcRenderer.on('screenshare-ice', handler);
    return () => ipcRenderer.removeListener('screenshare-ice', handler);
  },
  onScreenShareStop: (callback: (data: { sourceDeviceId: string; payload: ScreenShareStopPayload }) => void) => {
    const handler = (_: unknown, data: any) => callback(data);
    ipcRenderer.on('screenshare-stop', handler);
    return () => ipcRenderer.removeListener('screenshare-stop', handler);
  },
});
