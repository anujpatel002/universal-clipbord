import { contextBridge, ipcRenderer } from 'electron';
import {
  Device,
  LocalDeviceInfo,
  ClipboardItem,
  Transfer,
  PairingRequestItem,
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
  connectToIp: (ip: string, port?: number): Promise<boolean> => ipcRenderer.invoke('connect-to-ip', ip, port),

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
});
