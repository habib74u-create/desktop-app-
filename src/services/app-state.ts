// src/services/app-state.ts
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { log } from '../core/logger';

export interface AppSettings {
  /** UI theme */
  theme: 'system' | 'light' | 'dark';
  /** Launch Jarvis at login */
  launchAtLogin: boolean;
  /** Start minimized to tray */
  startMinimized: boolean;
  /** Global hotkey string, e.g. 'Fn' | 'CommandOrControl+Shift+J' */
  hotkey: string;
  /** Language for transcription ('auto' for detection) */
  language: string;
  /** Prefer local Whisper/Sherpa over cloud */
  preferLocal: boolean;
  /** Auto-paste transcript into frontmost app */
  autoPaste: boolean;
  /** Play UI sound effects */
  soundsEnabled: boolean;
  /** Show analysis overlay */
  overlayEnabled: boolean;
  /** Whisper model to use */
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  /** Analytics opt-in (default false) */
  analyticsEnabled: boolean;
}

export interface ConsentRecord {
  /** Terms accepted at */
  termsAcceptedAt: number | null;
  /** Privacy policy accepted at */
  privacyAcceptedAt: number | null;
  /** Analytics consent (independent of terms) */
  analyticsConsentAt: number | null;
  /** Microphone permission acknowledged */
  micAcknowledgedAt: number | null;
  /** Accessibility permission acknowledged */
  accessibilityAcknowledgedAt: number | null;
}

export interface SetupStatus {
  /** Completed onboarding flow */
  onboardingComplete: boolean;
  /** Downloaded required models */
  modelsReady: boolean;
  /** Completed permission prompts */
  permissionsReady: boolean;
  /** First successful transcription at */
  firstRunAt: number | null;
}

export interface AuthState {
  token: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  user: { id: string; email: string; name?: string } | null;
}

export interface PersistedState {
  version: number;
  settings: AppSettings;
  consent: ConsentRecord;
  setup: SetupStatus;
  auth: AuthState;
}

const STATE_VERSION = 1;

const DEFAULT_STATE: PersistedState = {
  version: STATE_VERSION,
  settings: {
    theme: 'system',
    launchAtLogin: false,
    startMinimized: false,
    hotkey: 'Fn',
    language: 'auto',
    preferLocal: true,
    autoPaste: true,
    soundsEnabled: true,
    overlayEnabled: true,
    whisperModel: 'base',
    analyticsEnabled: false,
  },
  consent: {
    termsAcceptedAt: null,
    privacyAcceptedAt: null,
    analyticsConsentAt: null,
    micAcknowledgedAt: null,
    accessibilityAcknowledgedAt: null,
  },
  setup: {
    onboardingComplete: false,
    modelsReady: false,
    permissionsReady: false,
    firstRunAt: null,
  },
  auth: {
    token: null,
    refreshToken: null,
    expiresAt: null,
    user: null,
  },
};

export interface AppStateEvents {
  'settings:changed': Partial<AppSettings>;
  'consent:changed': Partial<ConsentRecord>;
  'setup:changed': Partial<SetupStatus>;
  'auth:changed': AuthState;
  'state:loaded': PersistedState;
}

class AppState extends EventEmitter {
  private state: PersistedState = structuredClone(DEFAULT_STATE);
  private filePath = '';
  private saveTimer: NodeJS.Timeout | null = null;
  private loaded = false;

  /** Load from disk. Call once after app.whenReady(). */
  async load(): Promise<void> {
    if (this.loaded) return;
    const dir = app.getPath('userData');
    this.filePath = path.join(dir, 'jarvis-state.json');

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        this.state = migrate(parsed);
        log.services.info('app state loaded', { path: this.filePath });
      } else {
        log.services.info('no app state found, using defaults');
      }
    } catch (err) {
      log.services.error('failed to load app state, using defaults', err);
      this.state = structuredClone(DEFAULT_STATE);
    }

    this.loaded = true;
    this.emit('state:loaded', this.snapshot());
  }

  /** Force-save now. */
  async save(): Promise<void> {
    if (!this.filePath) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    } catch (err) {
      log.services.error('failed to save app state', err);
    }
  }

  /** Debounced save — safe to call on every change. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.save();
    }, 250);
  }

  /* ---- Settings --------------------------------------------------------- */

  getSettings(): Readonly<AppSettings> {
    return { ...this.state.settings };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.state.settings, ...patch };
    this.scheduleSave();
    this.emit('settings:changed', patch);
    return this.getSettings();
  }

  /* ---- Consent ---------------------------------------------------------- */

  getConsent(): Readonly<ConsentRecord> {
    return { ...this.state.consent };
  }

  updateConsent(patch: Partial<ConsentRecord>): ConsentRecord {
    this.state.consent = { ...this.state.consent, ...patch };
    this.scheduleSave();
    this.emit('consent:changed', patch);
    return this.getConsent();
  }

  /* ---- Setup ------------------------------------------------------------ */

  getSetup(): Readonly<SetupStatus> {
    return { ...this.state.setup };
  }

  updateSetup(patch: Partial<SetupStatus>): SetupStatus {
    this.state.setup = { ...this.state.setup, ...patch };
    this.scheduleSave();
    this.emit('setup:changed', patch);
    return this.getSetup();
  }

  /* ---- Auth ------------------------------------------------------------- */

  getAuth(): Readonly<AuthState> {
    return { ...this.state.auth };
  }

  setAuth(auth: AuthState): void {
    this.state.auth = { ...auth };
    this.scheduleSave();
    this.emit('auth:changed', this.getAuth());
  }

  clearAuth(): void {
    this.state.auth = { ...DEFAULT_STATE.auth };
    this.scheduleSave();
    this.emit('auth:changed', this.getAuth());
  }

  /* ---- Utilities -------------------------------------------------------- */

  snapshot(): PersistedState {
    return structuredClone(this.state);
  }

  reset(): void {
    this.state = structuredClone(DEFAULT_STATE);
    this.scheduleSave();
    log.services.warn('app state reset to defaults');
  }

  override emit<K extends keyof AppStateEvents>(event: K, payload: AppStateEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof AppStateEvents>(
    event: K,
    listener: (payload: AppStateEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

function migrate(parsed: Partial<PersistedState>): PersistedState {
  // Merge defaults so missing keys don't crash on upgrade
  const merged: PersistedState = {
    version: STATE_VERSION,
    settings: { ...DEFAULT_STATE.settings, ...(parsed.settings ?? {}) },
    consent: { ...DEFAULT_STATE.consent, ...(parsed.consent ?? {}) },
    setup: { ...DEFAULT_STATE.setup, ...(parsed.setup ?? {}) },
    auth: { ...DEFAULT_STATE.auth, ...(parsed.auth ?? {}) },
  };
  // Future migrations go here:
  // if ((parsed.version ?? 0) < 2) { ... }
  return merged;
}

let instance: AppState | null = null;

export function initAppState(): AppState {
  if (instance) return instance;
  instance = new AppState();
  return instance;
}

export function getAppState(): AppState {
  if (!instance) throw new Error('AppState not initialized');
  return instance;
}
