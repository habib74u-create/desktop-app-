// src/services/analysis-overlay-service.ts
import { BrowserWindow, screen } from 'electron';
import { EventEmitter } from 'events';
import path from 'path';
import { app } from 'electron';
import { log } from '../core/logger';
import { getAppSettingsService } from './app-settings-service';

export interface OverlayPayload {
  title: string;
  body: string;
  kind?: 'info' | 'success' | 'warning' | 'error';
  /** Auto-dismiss in ms; 0 = manual */
  dismissAfterMs?: number;
}

export class AnalysisOverlayService extends EventEmitter {
  private win: BrowserWindow | null = null;
  private dismissTimer: NodeJS.Timeout | null = null;

  init(): void {
    log.services.info('analysis-overlay-service ready');
  }

  isEnabled(): boolean {
    return getAppSettingsService().get().overlayEnabled;
  }

  async show(payload: OverlayPayload): Promise<void> {
    if (!this.isEnabled()) return;
    const win = this.ensureWindow();

    // Position: bottom-right of primary display
    const { workArea } = screen.getPrimaryDisplay();
    const [w, h] = win.getSize();
    win.setPosition(workArea.x + workArea.width - w - 24, workArea.y + workArea.height - h - 24);

    win.showInactive();
    win.webContents.send('overlay:show', payload);
    log.services.debug('overlay shown', { title: payload.title });

    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    const after = payload.dismissAfterMs ?? 4000;
    if (after > 0) {
      this.dismissTimer = setTimeout(() => this.hide(), after);
    }
  }

  hide(): void {
    if (!this.win) return;
    if (!this.win.isDestroyed()) this.win.hide();
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  dispose(): void {
    this.hide();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const isDev = !app.isPackaged;
    const win = new BrowserWindow({
      width: 360,
      height: 140,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setIgnoreMouseEvents(true, { forward: true });

    if (isDev) {
      void win.loadURL(`${process.env.JARVIS_DEV_URL ?? 'http://localhost:5173'}#/overlay`);
    } else {
      void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { hash: '/overlay' });
    }

    win.on('closed', () => {
      this.win = null;
    });

    this.win = win;
    return win;
  }
}

let instance: AnalysisOverlayService | null = null;
export function initAnalysisOverlayService(): AnalysisOverlayService {
  if (instance) return instance;
  instance = new AnalysisOverlayService();
  return instance;
}
export function getAnalysisOverlayService(): AnalysisOverlayService {
  if (!instance) throw new Error('AnalysisOverlayService not initialized');
  return instance;
}
