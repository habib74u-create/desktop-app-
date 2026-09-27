// src/ipc/ipc-handlers.ts
import { ipcMain, app, BrowserWindow } from 'electron';
import { log } from '../core/logger';
import { getMachineInfo } from '../core/machine-arch';
import { getJarvisCore } from '../core/jarvis-core';
import { getWindowManager } from '../services/window-manager';

import { CH, wrap } from './ipc-types';
import { registerNudgeIpcHandlers } from './nudge-ipc-handlers';
import { registerPermissionIpcHandlers } from './permission-ipc-handlers';
import { registerSettingsIpcHandlers } from './settings-ipc-handlers';
import { registerOnboardingIpcHandlers } from './onboarding-ipc-handlers';
import { registerDictationIpcHandlers } from './dictation-ipc-handlers';
import { registerUpdateIpcHandlers } from './update-ipc-handlers';
import { registerAuthIpcHandlers } from './auth-ipc-handlers';
import { registerChatIpcHandlers } from './chat-ipc-handlers';

let registered = false;

export function registerIpcHandlers(): void {
  if (registered) {
    log.ipc.warn('registerIpcHandlers() called twice — ignoring');
    return;
  }
  registered = true;

  registerCoreHandlers();
  registerSettingsIpcHandlers();
  registerPermissionIpcHandlers();
  registerOnboardingIpcHandlers();
  registerDictationIpcHandlers();
  registerNudgeIpcHandlers();
  registerChatIpcHandlers();
  registerUpdateIpcHandlers();
  registerAuthIpcHandlers();

  wireCoreBroadcasts();

  log.ipc.info('all IPC handlers registered');
}

/* -------------------------------------------------------------------------- */
/* Core / app-level channels                                                  */
/* -------------------------------------------------------------------------- */

function registerCoreHandlers(): void {
  ipcMain.handle(CH.appInfo, () =>
    wrap(() => ({
      version: app.getVersion(),
      name: app.getName(),
      machine: getMachineInfo(),
      coreState: getJarvisCore().getState(),
    }))
  );

  ipcMain.handle(CH.appQuit, () => {
    log.ipc.info('renderer requested quit');
    app.quit();
  });

  ipcMain.handle(CH.appFocusWindow, () =>
    wrap(() => {
      getWindowManager().focusOrCreate('main');
    })
  );
}

/* -------------------------------------------------------------------------- */
/* Push: main → renderer                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Broadcast a message to every open BrowserWindow.
 * Used by every handler below to push events (partial transcript, update state…).
 */
export function emitToAll(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

/** Broadcast a message only to a specific window kind. */
export function emitTo(kind: 'main' | 'overlay' | 'onboarding' | 'settings', channel: string, ...args: unknown[]): void {
  const win = getWindowManager().get(kind);
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function wireCoreBroadcasts(): void {
  const core = getJarvisCore();

  core.on('state:changed', (payload) => {
    emitToAll(CH.coreStateChanged, payload);
  });

  core.on('error', (payload) => {
    emitToAll(CH.coreError, payload);
  });

  core.on('transcript:partial', (payload) => {
    emitToAll(CH.dictationPartial, payload);
  });

  core.on('transcript:final', (payload) => {
    emitToAll(CH.dictationFinal, payload);
  });

  core.on('nudge', (payload) => {
    emitToAll(CH.nudgePush, payload);
  });
}
