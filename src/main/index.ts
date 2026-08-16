import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import * as path from 'node:path';
import { AppDatabase } from './database.js';
import { SecurityManager } from './security.js';
import { NetworkManager } from './network.js';
import { DiscoveryService } from './discovery.js';
import { ClipboardMonitor } from './clipboard.js';
import { TransferManager } from './transfer.js';
import { ClipboardItem } from '../shared/types.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: AppDatabase | null = null;
let security: SecurityManager | null = null;
let network: NetworkManager | null = null;
let discovery: DiscoveryService | null = null;
let clipboardMonitor: ClipboardMonitor | null = null;
let transferManager: TransferManager | null = null;
let isQuitting = false;

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 650,
    minHeight: 500,
    title: 'MultiClip',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const indexPath = path.join(__dirname, '../renderer/index.html');
    win.loadFile(indexPath);
  }

  win.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('MultiClip - Universal Clipboard & Transfer');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show MultiClip',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

async function initializeApp(): Promise<void> {
  const userDataDir = app.getPath('userData');
  db = new AppDatabase(userDataDir);
  await db.init();
  security = new SecurityManager(db);
  network = new NetworkManager(db, security, app.getVersion() || '1.0.0');
  discovery = new DiscoveryService(network);
  clipboardMonitor = new ClipboardMonitor(network, db);
  transferManager = new TransferManager(network, db);

  // Wire network events to UI
  network.on('devices_updated', (devices) => {
    mainWindow?.webContents.send('devices-updated', devices);
  });

  network.on('message', ({ deviceId, message }) => {
    if (message.type === 'CLIPBOARD_UPDATE') {
      const sender = deviceId ? network?.getDevice(deviceId) : null;
      if (!sender || !sender.trusted) {
        console.log(`[WARN] Ignored clipboard update from untrusted/unknown device: ${deviceId}`);
        return;
      }

      const item = message.payload as ClipboardItem;
      db?.addClipboardItem(item);

      if (item.type === 'text' && item.content) {
        // Instant seamless text sync to OS clipboard
        clipboardMonitor?.setClipboardText(item.content, true);
      } else if (item.type === 'file' && item.path && sender.id) {
        // Seamless file sync: Automatically fetch file in background so user can Ctrl+V immediately
        transferManager?.requestFileFromPeer(sender.id, item.path);
      }

      mainWindow?.webContents.send('clipboard-updated', item);
    }
  });

  clipboardMonitor.on('clipboard_updated', (item: ClipboardItem) => {
    mainWindow?.webContents.send('clipboard-updated', item);
    network?.broadcastMessage({
      type: 'CLIPBOARD_UPDATE',
      payload: item,
    }, true);
  });

  transferManager.on('transfer_updated', (transfer) => {
    mainWindow?.webContents.send('transfer-updated', transfer);

    // When an inbound file transfer completes, write it directly to OS clipboard for native Ctrl+V
    const local = network?.getLocalInfo();
    if (transfer.status === 'completed' && local && transfer.destinationDeviceId === local.id) {
      if (transferManager) {
        const destFilePath = path.join(transferManager.getDownloadDir(), transfer.fileName);
        clipboardMonitor?.setClipboardFile(destFilePath, true);
        console.log(`[INFO] Seamlessly synced file to OS clipboard: ${destFilePath} (Ready for Ctrl+V)`);
      }
    }
  });

  network.on('pairing_request', (req) => {
    mainWindow?.webContents.send('pairing-requested', req);
  });

  // Register IPC handlers
  ipcMain.handle('get-local-info', () => network?.getLocalInfo());
  ipcMain.handle('get-devices', () => network?.getAllDevices());
  ipcMain.handle('get-clipboard-history', () => db?.getClipboardHistory());
  ipcMain.handle('get-transfers', () => db?.getTransfers());
  
  ipcMain.handle('pair-device', (_event, deviceId: string) => {
    return network?.sendPairRequest(deviceId) || false;
  });

  ipcMain.handle('unpair-device', (_event, deviceId: string) => {
    network?.setDeviceTrusted(deviceId, false);
    return true;
  });

  ipcMain.handle('respond-pair-request', (_event, deviceId: string, accept: boolean) => {
    network?.respondToPairRequest(deviceId, accept);
  });

  ipcMain.handle('copy-to-local-clipboard', (_event, text: string) => {
    clipboardMonitor?.setClipboardText(text, true);
  });

  ipcMain.handle('broadcast-clipboard-text', (_event, text: string) => {
    if (!clipboardMonitor) return null;
    const item = clipboardMonitor.createLocalTextItem(text);
    mainWindow?.webContents.send('clipboard-updated', item);
    network?.broadcastMessage({
      type: 'CLIPBOARD_UPDATE',
      payload: item,
    }, true);
    return item;
  });

  ipcMain.handle('send-clipboard', (_event, targetDeviceId: string, item: ClipboardItem) => {
    network?.sendMessage(targetDeviceId, {
      type: 'CLIPBOARD_UPDATE',
      payload: item,
    });
  });

  ipcMain.handle('select-file-to-send', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('initiate-file-transfer', async (_event, targetDeviceId: string, filePath: string) => {
    if (!transferManager) throw new Error('TransferManager not initialized');
    return await transferManager.startOutboundTransfer(targetDeviceId, filePath);
  });

  ipcMain.handle('request-file-from-peer', (_event, sourceDeviceId: string, remoteFilePath: string) => {
    transferManager?.requestFileFromPeer(sourceDeviceId, remoteFilePath);
  });

  ipcMain.handle('pause-transfer', (_event, transferId: string) => {
    transferManager?.pauseTransfer(transferId);
  });

  ipcMain.handle('resume-transfer', (_event, transferId: string) => {
    transferManager?.resumeTransfer(transferId);
  });

  ipcMain.handle('cancel-transfer', (_event, transferId: string) => {
    transferManager?.cancelTransfer(transferId);
  });

  ipcMain.handle('connect-to-ip', async (_event, ip: string, port = 49152) => {
    try {
      if (!network) return { success: false, error: 'Network manager not ready' };
      const cleanInput = ip.trim();
      if (!cleanInput) return { success: false, error: 'IP address cannot be empty' };

      const dev = await network.connectToPeer(cleanInput, port);
      return { success: true, device: dev };
    } catch (err) {
      console.log(`[WARN] Manual connect to ${ip}:${port} failed: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  });

  // Start networking
  await network.startServer();
  discovery.start();
  clipboardMonitor.start();
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await initializeApp();
    mainWindow = createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (!tray) {
      app.quit();
    }
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  clipboardMonitor?.stop();
  discovery?.stop();
  network?.stop();
  db?.close();
});
