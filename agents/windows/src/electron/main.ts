import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig, ensureConfigDir, getConfigDir } from '../services/config.js';
import { loadProjects, autoDiscoverProjects } from '../services/projects.js';
import { connectToServer, disconnect } from '../services/connection.js';
import type { AgentConfig } from '../services/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let isConnected = false;
let isConnecting = false;
let currentConfig: AgentConfig | null = null;

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  // Someone tried to run a second instance, show settings window
  showSettingsWindow();
});

// Hide dock icon on macOS (we're tray-only)
if (process.platform === 'darwin') {
  app.dock?.hide();
}

app.whenReady().then(async () => {
  await ensureConfigDir();
  currentConfig = await loadConfig();

  createTray();

  // Auto-connect if token is configured
  if (currentConfig.token) {
    await startAgent();
  } else {
    showSettingsWindow();
  }
});

app.on('window-all-closed', (e: Event) => {
  // Don't quit when all windows are closed (tray app)
  e.preventDefault();
});

function getIconPath(): string {
  const assetsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '..', '..', 'assets');

  return path.join(assetsPath, 'icon.png');
}

function createTray() {
  const iconPath = getIconPath();

  // Create a default icon if the file doesn't exist
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // Create a simple colored icon
      icon = createDefaultIcon();
    }
  } catch {
    icon = createDefaultIcon();
  }

  // Resize for tray (16x16 on Windows)
  const trayIcon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('DevRelay Agent');

  updateTrayMenu();

  tray.on('click', () => {
    showSettingsWindow();
  });
}

function createDefaultIcon(): Electron.NativeImage {
  // Create a simple 16x16 icon programmatically
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  // Fill with a color based on connection status
  const color = isConnected ? [0, 200, 83, 255] : [158, 158, 158, 255]; // Green or Gray

  for (let i = 0; i < size * size; i++) {
    // Create a circle
    const x = i % size;
    const y = Math.floor(i / size);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 1;

    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

    if (dist <= r) {
      canvas[i * 4] = color[0];     // R
      canvas[i * 4 + 1] = color[1]; // G
      canvas[i * 4 + 2] = color[2]; // B
      canvas[i * 4 + 3] = color[3]; // A
    } else {
      canvas[i * 4 + 3] = 0; // Transparent
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function updateTrayMenu() {
  const statusText = isConnecting ? 'Connecting...' : (isConnected ? 'Connected' : 'Disconnected');
  const statusIcon = isConnecting ? '...' : (isConnected ? '●' : '○');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `DevRelay Agent`,
      enabled: false,
    },
    {
      label: `${statusIcon} ${statusText}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: isConnected ? 'Disconnect' : 'Connect',
      click: async () => {
        if (isConnected) {
          await stopAgent();
        } else {
          await startAgent();
        }
      },
      enabled: !isConnecting,
    },
    { type: 'separator' },
    {
      label: 'Settings...',
      click: () => showSettingsWindow(),
    },
    {
      label: 'Open Config Folder',
      click: () => shell.openPath(getConfigDir()),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        disconnect();
        app.quit();
      },
    },
  ]);

  tray?.setContextMenu(contextMenu);

  // Update icon based on status
  const icon = createDefaultIcon();
  tray?.setImage(icon.resize({ width: 16, height: 16 }));
}

async function startAgent() {
  if (isConnecting || isConnected) return;

  currentConfig = await loadConfig();

  if (!currentConfig.token) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Token Required',
      message: 'Please configure your connection token in Settings.',
    });
    showSettingsWindow();
    return;
  }

  isConnecting = true;
  updateTrayMenu();

  try {
    // Auto-discover projects
    for (const dir of currentConfig.projectsDirs) {
      await autoDiscoverProjects(dir);
    }

    const projects = await loadProjects(currentConfig);

    await connectToServer(currentConfig, projects);

    isConnected = true;
    isConnecting = false;
    updateTrayMenu();

    // Notify settings window if open
    settingsWindow?.webContents.send('status-changed', { connected: true });
  } catch (err: any) {
    isConnecting = false;
    updateTrayMenu();

    dialog.showMessageBox({
      type: 'error',
      title: 'Connection Failed',
      message: `Failed to connect: ${err.message}`,
    });
  }
}

async function stopAgent() {
  disconnect();
  isConnected = false;
  updateTrayMenu();

  settingsWindow?.webContents.send('status-changed', { connected: false });
}

function showSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 500,
    resizable: false,
    maximizable: false,
    minimizable: true,
    title: 'DevRelay Agent Settings',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'preload.js')
        : path.join(__dirname, '..', '..', 'assets', 'preload.js'),
    },
    autoHideMenuBar: true,
    show: false,
  });

  // Load the settings HTML
  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'settings.html')
    : path.join(__dirname, '..', '..', 'assets', 'settings.html');

  settingsWindow.loadFile(htmlPath);

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// IPC handlers for settings window
ipcMain.handle('get-config', async () => {
  return await loadConfig();
});

// Helper to get login item settings options for dev environment
function getLoginItemOptions() {
  if (app.isPackaged) {
    return { path: process.execPath };
  } else {
    const appPath = path.resolve(__dirname, '..', '..');
    return { path: process.execPath, args: [appPath] };
  }
}

ipcMain.handle('get-auto-launch', () => {
  return app.getLoginItemSettings(getLoginItemOptions()).openAtLogin;
});

ipcMain.handle('set-auto-launch', (_event, enabled: boolean) => {
  const options = getLoginItemOptions();
  app.setLoginItemSettings({
    ...options,
    openAtLogin: enabled,
  });
  return app.getLoginItemSettings(options).openAtLogin;
});

ipcMain.handle('save-config', async (_event, config: Partial<AgentConfig>) => {
  const currentConfig = await loadConfig();
  const newConfig = { ...currentConfig, ...config };
  await saveConfig(newConfig);
  return newConfig;
});

ipcMain.handle('get-status', () => {
  return {
    connected: isConnected,
    connecting: isConnecting,
  };
});

ipcMain.handle('connect', async () => {
  await startAgent();
  return { connected: isConnected };
});

ipcMain.handle('disconnect', async () => {
  await stopAgent();
  return { connected: false };
});

ipcMain.handle('get-projects', async () => {
  const config = await loadConfig();
  return await loadProjects(config);
});

ipcMain.handle('scan-projects', async () => {
  const config = await loadConfig();
  let total = 0;
  for (const dir of config.projectsDirs) {
    total += await autoDiscoverProjects(dir);
  }
  return { added: total };
});

ipcMain.handle('add-projects-dir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Projects Directory',
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const config = await loadConfig();
    const newDir = result.filePaths[0];

    if (!config.projectsDirs.includes(newDir)) {
      config.projectsDirs.push(newDir);
      await saveConfig(config);
    }

    return { added: newDir, config };
  }

  return { added: null };
});

ipcMain.handle('remove-projects-dir', async (_event, dir: string) => {
  const config = await loadConfig();
  config.projectsDirs = config.projectsDirs.filter(d => d !== dir);
  await saveConfig(config);
  return config;
});
