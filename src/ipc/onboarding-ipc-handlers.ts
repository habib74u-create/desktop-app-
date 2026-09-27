// src/ipc/onboarding-ipc-handlers.ts
import { ipcMain, app } from 'electron';
import { log } from '../core/logger';
import { getPrivacyConsentService } from '../services/privacy-consent-service';
import { getSetupStatusService } from '../services/setup-status-service';
import { getWindowManager } from '../services/window-manager';
import { CH, wrap } from './ipc-types';

export function registerOnboardingIpcHandlers(): void {
  ipcMain.handle(CH.onboardingGetStatus, () =>
    wrap(() => ({
      consent: getPrivacyConsentService().get(),
      checklist: getSetupStatusService().getChecklist(),
      complete: getSetupStatusService().isComplete(),
    }))
  );

  ipcMain.handle(CH.onboardingComplete, () =>
    wrap(() => {
      getSetupStatusService().markOnboardingComplete();
      log.ipc.info('onboarding completed');

      // Swap to the main window
      const wm = getWindowManager();
      wm.close('onboarding');
      wm.focusOrCreate('main');

      return { ok: true };
    })
  );

  ipcMain.handle(CH.onboardingMarkModelsReady, () =>
    wrap(() => {
      getSetupStatusService().markModelsReady();
      return getSetupStatusService().getChecklist();
    })
  );

  ipcMain.handle(CH.onboardingRefresh, () =>
    wrap(() => getSetupStatusService().refresh())
  );

  log.ipc.debug('onboarding IPC ready');
}
