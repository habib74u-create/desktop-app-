// src/services/app-settings-service.ts
import { app, nativeTheme } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getAppState, type AppSettings } from './app-state';
import { getShortcutService } from './shortcut-service';

export class AppSettingsService extends EventEmitter {
  private state = getAppState();

  init(): void {
    log.services.info('app-settings-service ready');

    // Apply current settings on boot
    const s = this.state.getSettings();
    this.applyTheme(s.theme);
    this.applyLaunchAtLogin(s.launchAtLogin);
    this.applyHotkey(s.hotkey);

    // React to future changes
    this.state.on('settings:changed', (patch) => {
      if (patch.theme !== undefined) this.applyTheme(patch.theme);
      if (patch.launchAtLogin !== undefined) this.applyLaunchAtLogin(patch.launchAtLogin);
      if (patch.hotkey !== undefined) this.applyHotkey(patch.hotkey);
      this.emit('applied', patch);
    });
  }

  get(): Readonly<AppSettings> {
    return this.state.getSettings();
  }

  update(patch: Partial<AppSettings>): AppSettings {
    log.services.info('settings update', patch);
    return this.state.updateSettings(patch);
  }

  reset(): void {
    this.state.reset();
    const s = this.state.getSettings();
    this.applyTheme(s.theme);
    this.applyLaunchAtLogin(s.launchAtLogin);
    this.applyHotkey(s.hotkey);
  }

  /* ---- Side effects ----------------------------------------------------- */

  private applyTheme(theme: AppSettings['theme']): void {
    nativeTheme.themeSource = theme;
    log.services.debug(`theme applied: ${theme}`);
  }

  private applyLaunchAtLogin(enabled: boolean): void {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
        args: ['--start-minimized'],
      });
      log.services.debug(`launch-at-login: ${enabled}`);
    } catch (err) {
      log.services.error('failed to set login item', err);
    }
  }

  private applyHotkey(hotkey: string): void {
    try {
      getShortcutService().rebind(hotkey);
    } catch (err) {
      log.services.error(`failed to rebind hotkey: ${hotkey}`, err);
    }
  }
}

let instance: AppSettingsService | null = null;
export function initAppSettingsService(): AppSettingsService {
  if (instance) return instance;
  instance = new AppSettingsService();
  return instance;
}
export function getAppSettingsService(): AppSettingsService {
  if (!instance) throw new Error('AppSettingsService not initialized');
  return instance;
}
