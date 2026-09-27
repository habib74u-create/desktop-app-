// src/preload.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH } from './ipc/ipc-types';

type Unsub = () => void;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

function on<T>(channel: string, handler: (payload: T) => void): Unsub {
  const listener = (_e: IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const jarvis = {
  /* ---- app -------------------------------------------------------------- */
  app: {
    info: () => invoke(CH.appInfo),
    quit: () => invoke(CH.appQuit),
    focusWindow: () => invoke(CH.appFocusWindow),
    onStateChanged: (h: (p: { from: string; to: string; reason?: string }) => void) => on(CH.coreStateChanged, h),
    onError: (h: (p: { scope: string; message: string }) => void) => on(CH.coreError, h),
  },

  /* ---- settings --------------------------------------------------------- */
  settings: {
    get: () => invoke(CH.settingsGet),
    update: (patch: Record<string, unknown>) => invoke(CH.settingsUpdate, patch),
    reset: () => invoke(CH.settingsReset),
    onChanged: (h: (p: Record<string, unknown>) => void) => on(CH.settingsChanged, h),
  },

  /* ---- consent ---------------------------------------------------------- */
  consent: {
    get: () => invoke(CH.consentGet),
    acceptTerms: () => invoke(CH.consentAcceptTerms),
    acceptPrivacy: () => invoke(CH.consentAcceptPrivacy),
    setAnalytics: (enabled: boolean) => invoke(CH.consentSetAnalytics, enabled),
  },

  /* ---- permissions ------------------------------------------------------ */
  permissions: {
    check: () => invoke(CH.permissionsCheck),
    requestMic: () => invoke(CH.permissionsRequestMic),
    requestAccessibility: () => invoke(CH.permissionsRequestAccessibility),
    openSettings: (kind: string) => invoke(CH.permissionsOpenSettings, kind),
  },

  /* ---- onboarding ------------------------------------------------------- */
  onboarding: {
    getStatus: () => invoke(CH.onboardingGetStatus),
    complete: () => invoke(CH.onboardingComplete),
    markModelsReady: () => invoke(CH.onboardingMarkModelsReady),
    refresh: () => invoke(CH.onboardingRefresh),
  },

  /* ---- dictation -------------------------------------------------------- */
  dictation: {
    start: () => invoke(CH.dictationStart),
    stop: () => invoke(CH.dictationStop),
    cancel: () => invoke(CH.dictationCancel),
    onPartial: (h: (p: { text: string }) => void) => on(CH.dictationPartial, h),
    onFinal: (h: (p: { text: string }) => void) => on(CH.dictationFinal, h),
  },

  /* ---- nudge ------------------------------------------------------------ */
  nudge: {
    dismiss: (kind: string) => invoke(CH.nudgeDismiss, { kind }),
    action: (kind: string, action: string, payload?: unknown) =>
      invoke(CH.nudgeAction, { kind, action, payload }),
    onPush: (h: (p: { kind: string; payload: unknown }) => void) => on(CH.nudgePush, h),
  },

  /* ---- chat ------------------------------------------------------------- */
  chat: {
    send: (payload: { conversationId: string; message: string; context?: Record<string, unknown> }) =>
      invoke(CH.chatSend, payload),
    cancel: () => invoke(CH.chatCancel),
    onChunk: (h: (p: { requestId: string; text: string }) => void) => on(CH.chatChunk, h),
    onDone: (h: (p: { requestId: string; aborted?: boolean }) => void) => on(CH.chatDone, h),
  },

  /* ---- updates ---------------------------------------------------------- */
  update: {
    check: () => invoke(CH.updateCheck),
    download: () => invoke(CH.updateDownload),
    install: () => invoke(CH.updateInstall),
    onState: (h: (p: { state: string; info?: unknown; error?: string }) => void) => on(CH.updateState, h),
  },

  /* ---- auth ------------------------------------------------------------- */
  auth: {
    loginEmail: (email: string, password: string) => invoke(CH.authLoginEmail, { email, password }),
    loginBrowser: (provider: 'google' | 'github' | 'apple') => invoke(CH.authLoginBrowser, { provider }),
    logout: () => invoke(CH.authLogout),
    getUser: () => invoke(CH.authGetUser),
    onChanged: (h: (p: { state: string; user?: unknown }) => void) => on(CH.authChanged, h),
  },
};

contextBridge.exposeInMainWorld('jarvis', jarvis);

export type JarvisBridge = typeof jarvis;
