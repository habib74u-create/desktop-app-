// src/services/app-lifecycle-service.ts
import { app, BrowserWindow } from 'electron';
import { log } from '../core/logger';
import { getWindowManager } from './window-manager';
import { getShortcutService } from './shortcut-service';
import { getMenuService } from './menu-service';
import { getUpdateService } from './update-service';
import { getAnalysisOverlayService } from './analysis-overlay-service';
import { getJarvisCore } from '../core/jarvis-core';

export class AppLifecycleService {
  private quitting = false;
  private gotLock = false;

  /** Call this FIRST in main.ts (before app.whenReady). */
  acquireSingleInstance(): boolean {
    this.gotLock = app.requestSingleInstanceLock();
    if (!this.gotLock) {
      log.main.warn('another instance is running, quitting this one');
      app.quit();
      return false;
    }

    app.on('second-instance', (_event, argv, _cwd) => {
      log.main.info('second instance launched — focusing main window');
      const wm = getWindowManager();
      const main = wm.get('main');
      if (main) {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      } else {
        wm.focusOrCreate('main');
      }

      // Handle deep links passed to the second instance
      this.handleDeepLinkArgs(argv);
    });

    return true;
  }

  /** Wire up all lifecycle handlers. Call after app.whenReady(). */
  install(): void {
    // macOS: keep app running when all windows closed
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        log.main.info('all windows closed — quitting (non-macOS)');
        app.quit();
      }
    });

    // macOS: reopen on dock click
    app.on('activate', () => {
      const wm = getWindowManager();
      if (BrowserWindow.getAllWindows().length === 0) {
        wm.focusOrCreate('main');
      }
    });

    // Deep links (jarvis://...)
    app.on('open-url', (event, url) => {
      event.preventDefault();
      log.main.info(`deep link: ${url}`);
      this.handleDeepLink(url);
    });

    // Windows / Linux: argv-based deep links
    app.on('will-finish-launching', () => {
      this.handleDeepLinkArgs(process.argv);
    });

    // Quit sequence
    app.on('before-quit', async (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.quitting = true;
      await this.shutdown();
      app.exit(0);
    });

    log.main.info('app-lifecycle-service ready');
  }

  private async shutdown(): Promise<void> {
    log.main.info('shutting down…');
    try {
      getAnalysisOverlayService().dispose();
      getMenuService().dispose();
      getShortcutService().dispose();
      getUpdateService().dispose();
      await getJarvisCore().stop();
    } catch (err) {
      log.main.error('error during shutdown', err);
    }
  }

  private handleDeepLink(url: string): void {
    try {
      const u = new URL(url);
      if (u.hostname === 'auth' && u.pathname === '/callback') {
        const code = u.searchParams.get('code');
        if (code) {
          void import('./auth-service').then(({ getAuthService }) => {
            void getAuthService().completeBrowserLogin(code);
          });
        }
      } else if (u.hostname === 'open') {
        getWindowManager().focusOrCreate('main');
      }
    } catch (err) {
      log.main.error('invalid deep link', err);
    }
  }

  private handleDeepLinkArgs(argv: string[]): void {
    for (const arg of argv) {
      if (arg.startsWith('jarvis://')) this.handleDeepLink(arg);
    }
  }
}

let instance: AppLifecycleService | null = null;
export function initAppLifecycleService(): AppLifecycleService {
  if (instance) return instance;
  instance = new AppLifecycleService();
  return instance;
}
export function getAppLifecycleService(): AppLifecycleService {
  if (!instance) throw new Error('AppLifecycleService not initialized');
  return instance;
}
