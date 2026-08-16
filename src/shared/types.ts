export interface Device {
  id: string;
  name: string;
  ip: string;
  port: number;
  trusted: boolean;
  lastSeen: number;
  status: 'online' | 'offline' | 'connecting';
  publicKey?: string;
}

export interface LocalDeviceInfo {
  id: string;
  name: string;
  ip: string;
  port: number;
  version: string;
}

export type ClipboardContentType = 'text' | 'image' | 'file';

export interface ClipboardItem {
  id: string;
  type: ClipboardContentType;
  content?: string; // Text content or base64 thumbnail for images
  name?: string;    // File or image name
  size?: number;    // File size in bytes
  path?: string;    // Local path if copied locally
  sourceDeviceId: string;
  sourceDeviceName: string;
  timestamp: number;
}

export type TransferStatus =
  | 'pending'
  | 'transferring'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'interrupted';

export interface Transfer {
  id: string;
  sourceDeviceId: string;
  sourceDeviceName: string;
  destinationDeviceId: string;
  destinationDeviceName: string;
  fileName: string;
  size: number;
  transferred: number;
  chunkSize: number;
  totalChunks: number;
  status: TransferStatus;
  speed?: number; // bytes/sec
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageType =
  | 'HELLO'
  | 'HELLO_ACK'
  | 'PAIR_REQUEST'
  | 'PAIR_ACCEPT'
  | 'PAIR_REJECT'
  | 'DEVICE_LIST'
  | 'CLIPBOARD_UPDATE'
  | 'REQUEST_FILE'
  | 'TRANSFER_REQUEST'
  | 'TRANSFER_ACCEPT'
  | 'TRANSFER_REJECT'
  | 'CHUNK'
  | 'CHUNK_ACK'
  | 'TRANSFER_PAUSE'
  | 'TRANSFER_RESUME'
  | 'TRANSFER_CANCEL'
  | 'TRANSFER_COMPLETE'
  | 'ERROR';

export interface HelloPayload {
  deviceId: string;
  deviceName: string;
  port: number;
  version: string;
  publicKey?: string;
}

export interface PairRequestPayload {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  nonce: string;
  signature: string;
}

export interface PairAcceptPayload {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  nonce: string;
  signature: string;
}

export interface PairRejectPayload {
  deviceId: string;
  reason?: string;
}

export interface PairingRequestItem {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  timestamp: number;
}

export interface ProtocolMessage<T = unknown> {
  type: MessageType;
  payload: T;
}

export interface MultiClipAPI {
  getLocalInfo: () => Promise<LocalDeviceInfo>;
  getDevices: () => Promise<Device[]>;
  getClipboardHistory: () => Promise<ClipboardItem[]>;
  getTransfers: () => Promise<Transfer[]>;
  pairDevice: (deviceId: string) => Promise<boolean>;
  unpairDevice: (deviceId: string) => Promise<boolean>;
  respondToPairRequest: (deviceId: string, accept: boolean) => Promise<void>;
  copyToLocalClipboard: (text: string) => Promise<void>;
  broadcastClipboardText: (text: string) => Promise<ClipboardItem>;
  sendClipboardToDevice: (targetDeviceId: string, item: ClipboardItem) => Promise<void>;
  initiateFileTransfer: (targetDeviceId: string, filePath: string) => Promise<Transfer>;
  requestFileFromPeer: (sourceDeviceId: string, remoteFilePath: string) => Promise<void>;
  selectFileToSend: () => Promise<string | null>;
  pauseTransfer: (transferId: string) => Promise<void>;
  resumeTransfer: (transferId: string) => Promise<void>;
  cancelTransfer: (transferId: string) => Promise<void>;
  connectToIp: (ip: string, port?: number) => Promise<boolean>;
  onDeviceUpdate: (callback: (devices: Device[]) => void) => () => void;
  onClipboardUpdate: (callback: (item: ClipboardItem) => void) => () => void;
  onTransferUpdate: (callback: (transfer: Transfer) => void) => () => void;
  onPairingRequest: (callback: (request: PairingRequestItem) => void) => () => void;
}

declare global {
  interface Window {
    multiclip: MultiClipAPI;
  }
}
