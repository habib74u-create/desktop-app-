// src/ipc/nudge-ipc-handlers.ts
import { ipcMain } from 'electron';
import { log } from '../core/logger';
import { getAnalysisOverlayService } from '../services/analysis-overlay-service';
import { CH, wrap } from './ipc-types';

interface DismissPayload {
  kind: string;
}

interface ActionPayload {
  kind: string;
  action: string;
  payload?: unknown;
}

export function registerNudgeIpcHandlers(): void {
  ipcMain.handle(CH.nudgeDismiss, (_e, _p: DismissPayload) =>
    wrap(() => {
      getAnalysisOverlayService().hide();
      return { dismissed: true };
    })
  );

  ipcMain.handle(CH.nudgeAction, (_e, p: ActionPayload) =>
    wrap(() => {
      log.ipc.info(`nudge action: ${p.kind}/${p.action}`, p.payload);
      // Agents can subscribe to a bus if you want; for now, log + dismiss.
      getAnalysisOverlayService().hide();
      return { ok: true };
    })
  );

  log.ipc.debug('nudge IPC ready');
}
