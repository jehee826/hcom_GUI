import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { ProjectManager } from '../src/runtime/index.ts';
import { startGuiServer, type GuiServerHandle } from '../src/server/index.ts';
import { defaultCodexCandidates, resolveExecutable } from '../src/server/diagnostics.ts';
import { launchInstallerExe } from './updater.ts';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(CURRENT_DIR, '..');
const WEB_DIR = resolve(DIST_DIR, 'web');
const PRELOAD_PATH = resolve(CURRENT_DIR, 'preload.cjs');
const ICON_PATH = existsSync(resolve(DIST_DIR, 'assets', 'icon.png'))
  ? resolve(DIST_DIR, 'assets', 'icon.png')
  : resolve(DIST_DIR, '..', 'build', 'icon.png');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let manager: ProjectManager | null = null;
let serverHandle: GuiServerHandle | null = null;
let isQuitting = false;
let shutdownPromise: Promise<void> | null = null;

function resolveDataDir(): string {
  if (process.env.HCOM_GUI_DATA_DIR?.trim()) {
    return resolve(process.env.HCOM_GUI_DATA_DIR.trim());
  }
  if (process.env.LOCALAPPDATA?.trim()) {
    return join(process.env.LOCALAPPDATA.trim(), 'hcom_gui');
  }
  return app.getPath('userData');
}

function parseWorkerSettings(): Record<string, unknown> | undefined {
  const raw = process.env.HCOM_GUI_WORKER_SETTINGS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function resolveCodexModel(): string | undefined {
  const raw = process.env.HCOM_GUI_MODEL;
  if (raw === undefined) return 'gpt-6.1-sol';
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'default' || trimmed === 'auto') return undefined;
  return trimmed;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function shutdownAndExit(code = 0): Promise<void> {
  if (!shutdownPromise) {
    isQuitting = true;
    shutdownPromise = (async () => {
      try {
        if (manager) await manager.shutdownAll();
      } catch {}
      try {
        if (serverHandle) await serverHandle.close();
      } catch {}
      try {
        tray?.destroy();
        tray = null;
      } catch {}
    })();
  }
  await shutdownPromise;
  app.exit(code);
}

async function promptAndRunInstallerUpdate(): Promise<{ launched: boolean; cancelled?: boolean; error?: string }> {
  const browser = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = browser
    ? await dialog.showOpenDialog(browser, {
      title: '최신 hcom_gui 설치 파일(.exe) 선택',
      properties: ['openFile'],
      filters: [{ name: 'Windows 설치 파일', extensions: ['exe'] }],
    })
    : await dialog.showOpenDialog({
      title: '최신 hcom_gui 설치 파일(.exe) 선택',
      properties: ['openFile'],
      filters: [{ name: 'Windows 설치 파일', extensions: ['exe'] }],
    });
  if (result.canceled || result.filePaths.length === 0) {
    return { launched: false, cancelled: true };
  }
  try {
    launchInstallerExe(result.filePaths[0]!, { currentExePath: app.getPath('exe') });
    setTimeout(() => { void shutdownAndExit(0); }, 250);
    return { launched: true };
  } catch (error) {
    return {
      launched: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createTray(): void {
  const image = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip(`hcom_gui v${app.getVersion()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'hcom_gui 창 열기', click: () => showMainWindow() },
    { label: '최신 설치 파일(.exe)로 업데이트', click: () => { void promptAndRunInstallerUpdate(); } },
    { type: 'separator' },
    { label: '완전 종료', click: () => { void shutdownAndExit(0); } },
  ]));
  tray.on('double-click', () => showMainWindow());
}

function createWindow(baseUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    title: 'hcom_gui',
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(baseUrl)) event.preventDefault();
  });

  win.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  void win.loadURL(`${baseUrl}/index.html`);
  return win;
}

async function startApp(): Promise<void> {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  const codexCommand = resolveExecutable(
    process.env.HCOM_GUI_CODEX_PATH?.trim() || undefined,
    'codex',
    defaultCodexCandidates(),
  ) ?? 'codex.exe';
  const codexModel = resolveCodexModel();
  const workerSettings = parseWorkerSettings();

  manager = new ProjectManager({
    dataDir,
    codexCommand,
    model: codexModel,
    workerSettings,
  });

  serverHandle = await startGuiServer({
    manager,
    appVersion: app.getVersion(),
    staticDir: WEB_DIR,
    codexCommand,
  });

  ipcMain.handle('hcomGui:getConfig', () => ({
    baseUrl: serverHandle!.baseUrl,
    token: serverHandle!.token,
    version: app.getVersion(),
    dataDir,
  }));

  ipcMain.handle('hcomGui:pickFolder', async () => {
    const browser = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const res = browser
      ? await dialog.showOpenDialog(browser, {
        title: '로컬 Git 프로젝트 폴더 선택',
        properties: ['openDirectory'],
      })
      : await dialog.showOpenDialog({
        title: '로컬 Git 프로젝트 폴더 선택',
        properties: ['openDirectory'],
      });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0]!;
  });

  ipcMain.handle('hcomGui:pickInstallerAndUpdate', async () => promptAndRunInstallerUpdate());

  mainWindow = createWindow(serverHandle.baseUrl);
  createTray();

  const testInfoFile = process.env.HCOM_GUI_TEST_INFO_FILE?.trim();
  if (testInfoFile) {
    mkdirSync(dirname(resolve(testInfoFile)), { recursive: true });
    writeFileSync(resolve(testInfoFile), JSON.stringify({
      baseUrl: serverHandle.baseUrl,
      token: serverHandle.token,
      version: app.getVersion(),
      dataDir,
      pid: process.pid,
    }, null, 2), 'utf8');
  }
}

const gotSingleInstanceLock = process.env.HCOM_GUI_ALLOW_MULTI_INSTANCE === '1'
  ? true
  : app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => {
    // 트레이 상주 모드에서는 창이 닫혀도 백엔드를 유지한다.
  });
  process.on('SIGINT', () => { void shutdownAndExit(0); });
  process.on('SIGTERM', () => { void shutdownAndExit(0); });

  app.whenReady()
    .then(startApp)
    .catch(error => {
      const msg = error instanceof Error ? error.stack ?? error.message : String(error);
      dialog.showErrorBox('hcom_gui 시작 오류', msg);
      void shutdownAndExit(1);
    });
}
