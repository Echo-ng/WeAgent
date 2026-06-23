import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AppService } from '@weagent/core';
import { WeChatILinkAdapter } from '@weagent/channels-wechat';
import { registerIpcHandlers, ensureWeChatListening } from './ipc.js';
import { getResourcePath } from './paths.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appService: AppService;
let wechatAdapter: WeChatILinkAdapter;

const isDev = !app.isPackaged;
const dataDir = join(app.getPath('userData'), 'data');

function resolveMcpServerScript(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve('@weagent/mcp-weagent/dist/index.js');
  } catch {
    const fallback = join(__dirname, '../../../packages/mcp-weagent/dist/index.js');
    if (existsSync(fallback)) return fallback;
    return undefined;
  }
}

function loadAppIcon(): Electron.NativeImage {
  const iconPath = getResourcePath('icon.png');
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) return image;
  return nativeImage.createFromPath(getResourcePath('tray.png'));
}

function loadTrayIcon(): Electron.NativeImage {
  const candidates = ['tray.ico', 'tray-32.png', 'tray.png'];
  for (const name of candidates) {
    const image = nativeImage.createFromPath(getResourcePath(name));
    if (!image.isEmpty()) {
      return image;
    }
  }
  return loadAppIcon();
}

function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createWindow(): void {
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'WeAgent',
    autoHideMenuBar: true,
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173');
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  const icon = loadTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('WeAgent');
  tray.on('double-click', () => {
    showMainWindow();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 WeAgent',
        click: () => {
          showMainWindow();
        },
      },
      {
        label: '退出',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
}

function resolveTaskSearchDirs(): string[] {
  const candidates = [
    process.cwd(),
    join(__dirname, '../..'),
    join(__dirname, '../../..'),
  ];
  return [...new Set(candidates.filter((d) => existsSync(d)))];
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  appService = new AppService({
    dataDir,
    mcpServerScriptPath: resolveMcpServerScript(),
    taskSearchDirs: resolveTaskSearchDirs(),
  });
  await appService.startTaskBridge();

  wechatAdapter = new WeChatILinkAdapter({
    credentialsPath: join(dataDir, 'wechat-credentials.json'),
    baseUrl: appService.getSettings().wechatBaseUrl,
    onMessage: async (msg) => {
      await appService.channelRouter.handleWeChatMessage(msg);
    },
  });

  appService.channelRouter.registerAdapter(wechatAdapter);
  registerIpcHandlers(ipcMain, appService, wechatAdapter, () => mainWindow);

  void ensureWeChatListening(appService, wechatAdapter);

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep running in tray on Windows
  }
});

app.on('before-quit', () => {
  void wechatAdapter?.stop();
  appService?.shutdown();
});
