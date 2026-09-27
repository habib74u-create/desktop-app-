// src/ipc/settings-ipc-handlers.ts
import { ipcMain } from 'electron';
import { log } from '../core/logger';
import { getAppSettingsService } from '../services/app-settings-service';
import { getAppState, type AppSettings } from '../services/app-state';
import { CH, wrap } from './ipc-types';
import { emitToAll } from './ipc-handlers';

export function registerSettingsIpcHandlers(): void {
  ipcMain.handle(CH.settingsGet, () =>
    wrap(() => getAppSettingsService().get())
  );

  ipcMain.handle(CH.settingsUpdate, (_e, patch: Partial<AppSettings>) =>
    wrap(() => {
      const next = getAppSettingsService().update(patch ?? {});
      log.ipc.debug('settings updated from renderer', patch);
      return next;
    })
  );

  ipcMain.handle(CH.settingsReset, () =>
    wrap(() => {
      getAppSettingsService().reset();
      return getAppSettingsService().get();
    })
  );

  // Watch AppState and broadcast changes to all windows
  getAppState().on('settings:changed', (patch) => {
    emitToAll(CH.settingsChanged, patch);
  });

  log.ipc.debug('settings IPC ready');
}
