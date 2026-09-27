// src/services/update-service.ts
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getAppState } from './app-state';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateEvents {
  'state:changed': { state: UpdateState; info?: UpdateInfo | ProgressInfo; error?: string };
}

export class UpdateService extends EventEmitter {
  private state: UpdateState = 'idle';
  private checkInterval: NodeJS.Timeout | null = null;
  private currentInfo: UpdateInfo | null = null;

  init(): void {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => this.setState('checking'));
    autoUpdater.on('update-available', (info) => {
      this.currentInfo = info;
      this.setState('available', info);
    });
    autoUpdater.on('update-not-available', (info) => this.setState('not-available', info));
    autoUpdater.on('download-progress', (p) => this.setState('downloading', p));
    autoUpdater.on('update-downloaded', (info) => {
      this.currentInfo = info;
      this.setState('downloaded', info);
    });
    autoUpdater.on('error', (err) => {
      log.updater.error('updater error', err);
      this.setState('error', undefined, err.message);
    });

    log.updater.info(`update-service ready (current v${app.getVersion()})`);

    // Check on boot (after a short delay) unless disabled
    if (!process.argv.includes('--no-update-check')) {
      setTimeout(() => void this.check(), 10_000);
    }

    // Check every 6h
    this.checkInterval = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
  }

  dispose(): void {
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.checkInterval = null;
  }

  getState(): UpdateState {
    return this.state;
  }

  getInfo(): UpdateInfo | null {
    return this.currentInfo;
  }

  async check(): Promise<void> {
    if (app.isPackaged === false) {
      log.updater.debug('skipping check in dev');
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      log.updater.error('check failed', err);
    }
  }

  async download(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      log.updater.error('download failed', err);
      this.setState('error', undefined, (err as Error).message);
    }
  }

  /** Quit and install (call after user confirms). */
  quitAndInstall(): void {
    log.updater.info('quitting and installing update');
    autoUpdater.quitAndInstall(false, true);
  }

  private setState(state: UpdateState, info?: UpdateInfo | ProgressInfo, error?: string): void {
    this.state = state;
    log.updater.debug(`update state → ${state}`, error ?? '');
    this.emit('state:changed', { state, info, error });
  }

  override emit<K extends keyof UpdateEvents>(event: K, payload: UpdateEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof UpdateEvents>(
    event: K,
    listener: (payload: UpdateEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

let instance: UpdateService | null = null;
export function initUpdateService(): UpdateService {
  if (instance) return instance;
  instance = new UpdateService();
  return instance;
}
export function getUpdateService(): UpdateService {
  if (!instance) throw new Error('UpdateService not initialized');
  return instance;
}
