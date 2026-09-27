// src/ipc/ipc-types.ts
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function err(message: string, code?: string): IpcResult<never> {
  return { ok: false, error: message, code };
}

export function wrap<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  return (async () => {
    try {
      const data = await fn();
      return ok(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string }).code;
      return err(msg, code);
    }
  })();
}

/** Channel name constants — imported by both main and preload. */
export const CH = {
  // generic
  appInfo: 'app:info',
  appQuit: 'app:quit',
  appFocusWindow: 'app:focus-window',

  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',
  settingsChanged: 'settings:changed',

  // consent / privacy
  consentGet: 'consent:get',
  consentAcceptTerms: 'consent:accept-terms',
  consentAcceptPrivacy: 'consent:accept-privacy',
  consentSetAnalytics: 'consent:set-analytics',

  // permissions
  permissionsCheck: 'permissions:check',
  permissionsRequestMic: 'permissions:request-mic',
  permissionsRequestAccessibility: 'permissions:request-accessibility',
  permissionsOpenSettings: 'permissions:open-settings',

  // onboarding / setup
  onboardingGetStatus: 'onboarding:get-status',
  onboardingComplete: 'onboarding:complete',
  onboardingMarkModelsReady: 'onboarding:mark-models-ready',
  onboardingRefresh: 'onboarding:refresh',

  // dictation
  dictationStart: 'dictation:start',
  dictationStop: 'dictation:stop',
  dictationCancel: 'dictation:cancel',
  dictationPartial: 'dictation:partial',
  dictationFinal: 'dictation:final',
  dictationState: 'dictation:state',

  // nudge
  nudgeDismiss: 'nudge:dismiss',
  nudgeAction: 'nudge:action',
  nudgePush: 'nudge:push',

  // chat / transcription chat
  chatSend: 'chat:send',
  chatChunk: 'chat:chunk',
  chatDone: 'chat:done',
  chatCancel: 'chat:cancel',

  // updates
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateState: 'update:state',

  // auth
  authLoginEmail: 'auth:login-email',
  authLoginBrowser: 'auth:login-browser',
  authLogout: 'auth:logout',
  authGetUser: 'auth:get-user',
  authChanged: 'auth:changed',

  // core state broadcast
  coreStateChanged: 'core:state-changed',
  coreError: 'core:error',
} as const;
