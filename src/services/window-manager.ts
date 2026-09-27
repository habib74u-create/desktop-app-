// src/services/window-manager.ts
import { BrowserWindow, screen, shell, app } from 'electron';
import path from 'path';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getAppState } from './app-state';

export type WindowKind = 'main' | 'overlay' | 'onboarding' | 'settings';

export interface WindowManagerEvents {
  'window:created': { kind: WindowKind; id: number };
  'window:closed': { kind: WindowKind; id: number };
  'window:focused': { kind: WindowKind; id: number };
}

const isDev = !app.isPackaged;
const DEV_URL = process.env.JARVIS_DEV_URL ?? 'http://localhost:5173';

export class WindowManager extends EventEmitter {
  private windows = new Map<WindowKind, BrowserWindow>();
  private preloadPath = '';

  init(): void {
    this.preloadPath = path.join(__dirname, '..', 'preload.js');
    log.services.info('window-manager ready');
  }

  /* ---- Public API ------------------------------------------------------- */

  get(kind: WindowKind): BrowserWindow | undefined {
    return this.windows.get(kind);
  }

  focusOrCreate(kind: WindowKind): BrowserWindow {
    const existing = this.windows.get(kind);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return existing;
    }
    return this.create(kind);
  }

  create(kind: WindowKind): BrowserWindow {
    const existing = this.windows.get(kind);
    if (existing && !existing.isDestroyed()) return existing;

    const win = new BrowserWindow({
      ...this.getWindowOptions(kind),
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
      show: false,
    });

    this.windows.set(kind, win);

    win.once('ready-to-show', () => {
      const settings = getAppState().getSettings();
      if (!(kind === 'main' && settings.startMinimized)) {
        win.show();
      }
    });

    win.on('closed', () => {
      this.windows.delete(kind);
      this.emit('window:closed', { kind, id: win.id });
      log.services.debug(`window closed: ${kind}`);
    });

    win.on('focus', () => {
      this.emit('window:focused', { kind, id: win.id });
    });

    // Open external links in the OS browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    // Block navigation away from our app
    win.webContents.on('will-navigate', (event, url) => {
      const allowed = isDev ? DEV_URL : 'file://';
      if (!url.startsWith(allowed)) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    });

    void this.loadUrl(win, kind);

    this.emit('window:created', { kind, id: win.id });
    log.services.debug(`window created: ${kind}`);
    return win;
  }

  close(kind: WindowKind): void {
    const win = this.windows.get(kind);
    if (win && !win.isDestroyed()) win.close();
  }

  closeAll(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.close();
    }
    this.windows.clear();
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args);
    }
  }

  /* ---- Internals -------------------------------------------------------- */

  private async loadUrl(win: BrowserWindow, kind: WindowKind): Promise<void> {
    const hash = `#/${kind}`;
    if (isDev) {
      await win.loadURL(`${DEV_URL}${hash}`);
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { hash });
    }
  }

  private getWindowOptions(kind: WindowKind): Electron.BrowserWindowConstructorOptions {
    switch (kind) {
      case 'overlay': {
        const display = screen.getPrimaryDisplay();
        const { width, height } = display.workAreaSize;
        return {
          width: Math.min(480, width),
          height: Math.min(240, height),
          x: width - 500,
          y: 20,
          frame: false,
          transparent: true,
          resizable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          hasShadow: false,
          focusable: false,
        };
      }
      case 'onboarding':
        return {
          width: 720,
          height: 560,
          resizable: false,
          title: 'Welcome to Jarvis',
          backgroundColor: '#0b0b0f',
        };
      case 'settings':
        return {
          width: 860,
          height: 620,
          title: 'Jarvis Settings',
          backgroundColor: '#0b0b0f',
        };
      case 'main':
      default:
        return {
          width: 1100,
          height: 720,
          minWidth: 800,
          minHeight: 560,
          title: 'Jarvis',
          backgroundColor: '#0b0b0f',
          titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        };
    }
  }
}

let instance: WindowManager | null = null;
export function initWindowManager(): WindowManager {
  if (instance) return instance;
  instance = new WindowManager();
  return instance;
}
export function getWindowManager(): WindowManager {
  if (!instance) throw new Error('WindowManager not initialized');
  return instance;
}
