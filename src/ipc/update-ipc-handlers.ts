// src/ipc/update-ipc-handlers.ts
import { ipcMain } from 'electron';
import { log } from '../core/logger';
import { getUpdateService } from '../services/update-service';
import { CH, wrap } from './ipc-types';
import { emitToAll } from './ipc-handlers';

export function registerUpdateIpcHandlers(): void {
  const svc = getUpdateService();

  ipcMain.handle(CH.updateCheck, () =>
    wrap(async () => {
      await svc.check();
      return { state: svc.getState(), info: svc.getInfo() };
    })
  );

  ipcMain.handle(CH.updateDownload, () =>
    wrap(async () => {
      await svc.download();
      return { state: svc.getState() };
    })
  );

  ipcMain.handle(CH.updateInstall, () =>
    wrap(() => {
      svc.quitAndInstall();
      return { ok: true };
    })
  );

  // Push update state changes to all windows
  svc.on('state:changed', (payload) => {
    emitToAll(CH.updateState, payload);
  });

  log.ipc.debug('update IPC ready');
}
