// src/ipc/dictation-ipc-handlers.ts
import { ipcMain } from 'electron';
import { log } from '../core/logger';
import { getJarvisCore } from '../core/jarvis-core';
import { getTranscriptionService } from '../services/transcription-service';
import { getPowerManagementService } from '../services/power-management-service';
import { CH, wrap } from './ipc-types';
import { emitToAll } from './ipc-handlers';

let currentStream: { stop: () => Promise<unknown> } | null = null;

export function registerDictationIpcHandlers(): void {
  ipcMain.handle(CH.dictationStart, () =>
    wrap(async () => {
      const core = getJarvisCore();
      if (core.getState() === 'listening') return { already: true };
      core.setState('listening', 'renderer-start');
      getPowerManagementService().preventSleep();

      // Optional: start streaming transcription if the engine supports it
      try {
        const stream = await getTranscriptionService().startStream((partial) => {
          emitToAll(CH.dictationPartial, { text: partial });
        });
        currentStream = stream;
      } catch {
        // Engine doesn't support streaming — that's fine
      }

      return { started: true };
    })
  );

  ipcMain.handle(CH.dictationStop, () =>
    wrap(async () => {
      const core = getJarvisCore();
      if (core.getState() !== 'listening') return { stopped: false };

      getPowerManagementService().allowSleep();

      if (currentStream) {
        try {
          const final = await currentStream.stop();
          currentStream = null;
          emitToAll(CH.dictationFinal, final);
          return final;
        } catch (e) {
          currentStream = null;
          throw e;
        }
      }

      core.setState('idle', 'renderer-stop');
      return { stopped: true };
    })
  );

  ipcMain.handle(CH.dictationCancel, () =>
    wrap(async () => {
      if (currentStream) {
        try {
          await currentStream.stop();
        } catch {
          /* ignore */
        }
        currentStream = null;
      }
      getJarvisCore().setState('idle', 'renderer-cancel');
      getPowerManagementService().allowSleep();
      return { cancelled: true };
    })
  );

  log.ipc.debug('dictation IPC ready');
}
