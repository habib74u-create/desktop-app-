// src/ipc/permission-ipc-handlers.ts
import { ipcMain, systemPreferences, shell, app } from 'electron';
import { log } from '../core/logger';
import { getPrivacyConsentService } from '../services/privacy-consent-service';
import { getSetupStatusService } from '../services/setup-status-service';
import { CH, wrap } from './ipc-types';

export type PermissionKind = 'microphone' | 'accessibility' | 'screen' | 'input-monitoring';

export function registerPermissionIpcHandlers(): void {
  ipcMain.handle(CH.permissionsCheck, () =>
    wrap(() => ({
      microphone: checkMic(),
      accessibility: checkAccessibility(),
      platform: process.platform,
      checklist: getSetupStatusService().getChecklist(),
    }))
  );

  ipcMain.handle(CH.permissionsRequestMic, () =>
    wrap(async () => {
      if (process.platform === 'darwin') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (granted) getPrivacyConsentService().acknowledgeMicrophone();
        return { granted };
      }
      // Windows / Linux: handled at first getUserMedia call
      return { granted: true };
    })
  );

  ipcMain.handle(CH.permissionsRequestAccessibility, () =>
    wrap(() => {
      if (process.platform !== 'darwin') return { granted: true };
      // Prompts the user with the system dialog
      const granted = systemPreferences.isTrustedAccessibilityClient(true);
      if (granted) getPrivacyConsentService().acknowledgeAccessibility();
      return { granted };
    })
  );

  ipcMain.handle(CH.permissionsOpenSettings, (_e, kind: PermissionKind) =>
    wrap(async () => {
      const urls: Record<PermissionKind, string> = {
        microphone:
          process.platform === 'darwin'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
            : 'ms-settings:privacy-microphone',
        accessibility:
          process.platform === 'darwin'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
            : 'ms-settings:easeofaccess',
        screen:
          process.platform === 'darwin'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
            : 'ms-settings:privacy-screenshots',
        'input-monitoring':
          process.platform === 'darwin'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'
            : 'ms-settings:easeofaccess',
      };
      const url = urls[kind];
      if (url) await shell.openExternal(url);
    })
  );

  log.ipc.debug('permissions IPC ready');
}

function checkMic(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.getMediaAccessStatus('microphone') === 'granted';
}

function checkAccessibility(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return false;
  }
}
