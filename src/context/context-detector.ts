// src/context/context-detector.ts
import { systemPreferences } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getMachineInfo } from '../core/machine-arch';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface ActiveWindow {
  /** Window title (empty if permission denied on macOS) */
  title: string;
  /** App that owns the window */
  app: {
    name: string;
    processId: number;
    bundleId?: string;    // macOS only
    path?: string;
  };
  /** Active browser tab URL (macOS only, requires Accessibility permission) */
  url?: string;
  /** Memory usage of the owning process (bytes) */
  memoryUsage?: number;
  /** Window position and size */
  bounds?: { x: number; y: number; width: number; height: number };
  /** When this snapshot was captured (ms since epoch) */
  capturedAt: number;
}

export interface ContextChangeEvent {
  previous: ActiveWindow | null;
  current: ActiveWindow | null;
  /** True if only the title/url changed (same app) */
  sameApp: boolean;
  /** Duration the previous app was focused (ms) */
  previousDurationMs: number;
}

export interface ContextEvents {
  'context:changed': ContextChangeEvent;
  'context:same-app': ContextChangeEvent;
  'context:lost': void;
  'context:error': { message: string; fatal: boolean };
}

export interface ContextDetectorOptions {
  /** Poll interval in ms. Default 1500. */
  pollIntervalMs?: number;
  /** Emit `context:same-app` when only title/url changed. Default true. */
  trackTitleChanges?: boolean;
  /** Ignore switches to/from Jarvis itself. Default true. */
  ignoreSelf?: boolean;
  /** Minimum focus duration before emitting a change (ms). Default 300. */
  debounceMs?: number;
}

const DEFAULTS: Required<ContextDetectorOptions> = {
  pollIntervalMs: 1500,
  trackTitleChanges: true,
  ignoreSelf: true,
  debounceMs: 300,
};

/* -------------------------------------------------------------------------- */
/* Detector                                                                   */
/* -------------------------------------------------------------------------- */

export class ContextDetector extends EventEmitter {
  private opts: Required<ContextDetectorOptions>;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  private current: ActiveWindow | null = null;
  private currentSince = 0;
  private lastEmitted: ActiveWindow | null = null;
  private lastEmitAt = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getWindows: any = null;

  constructor(opts: ContextDetectorOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
  }

  /* ---- Lifecycle -------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.started) return;

    // Wayland check — get-windows doesn't support it [citation:15]
    if (process.platform === 'linux' && isWayland()) {
      const msg = 'context detector disabled: Wayland is not supported by get-windows';
      log.context.warn(msg);
      this.emit('context:error', { message: msg, fatal: false });
      return;
    }

    // Load get-windows (ESM only)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = await import('get-windows' /* webpackIgnore: true */);
      this.getWindows = mod;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.context.error(`failed to load get-windows: ${msg}`);
      this.emit('context:error', { message: msg, fatal: true });
      return;
    }

    // macOS permission check — skip title/url if not granted [citation:5]
    if (process.platform === 'darwin') {
      const access = this.checkMacPermissions();
      if (!access.accessibility) {
        log.context.warn('Accessibility permission not granted — URL will be unavailable');
      }
      if (!access.screenRecording) {
        log.context.warn('Screen Recording permission not granted — window title will be empty');
      }
    }

    this.started = true;
    this.scheduleNextPoll(0);
    log.context.info(`context detector started (poll=${this.opts.pollIntervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
    log.context.info('context detector stopped');
  }

  /* ---- Polling ---------------------------------------------------------- */

  private scheduleNextPoll(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll().finally(() => {
        if (this.started) this.scheduleNextPoll(this.opts.pollIntervalMs);
      });
    }, delay);
  }

  private async poll(): Promise<void> {
    try {
      const raw = await this.getWindows.activeWindow({
        // Disable prompts — we handle permission UX elsewhere [citation:5]
        accessibilityPermission: false,
        screenRecordingPermission: false,
      });

      if (!raw) {
        // No active window (all minimized, lock screen, etc.)
        if (this.current !== null) {
          this.current = null;
          this.emit('context:lost');
        }
        return;
      }

      const snapshot = this.normalize(raw);

      // Ignore Jarvis itself
      if (this.opts.ignoreSelf && this.isSelf(snapshot)) {
        return;
      }

      this.evaluate(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.context.debug(`poll failed: ${msg}`);
      // Don't spam errors — only emit once per unique message
      if (!this.lastErrorMsg || this.lastErrorMsg !== msg) {
        this.lastErrorMsg = msg;
        this.emit('context:error', { message: msg, fatal: false });
      }
    }
  }

  private lastErrorMsg: string | null = null;

  /* ---- Change detection ------------------------------------------------- */

  private evaluate(snapshot: ActiveWindow): void {
    const now = Date.now();

    // First observation
    if (this.current === null) {
      this.current = snapshot;
      this.currentSince = now;
      this.emitChange(null, snapshot, now);
      return;
    }

    const appChanged = this.current.app.processId !== snapshot.app.processId;
    const titleChanged = this.current.title !== snapshot.title;
    const urlChanged = this.current.url !== snapshot.url;

    if (!appChanged && !titleChanged && !urlChanged) {
      return; // No meaningful change
    }

    // Debounce quick flapping
    if (now - this.lastEmitAt < this.opts.debounceMs) {
      return;
    }

    const previous = this.current;
    const previousDurationMs = now - this.currentSince;

    if (appChanged) {
      this.current = snapshot;
      this.currentSince = now;
      this.emitChange(previous, snapshot, now, previousDurationMs);
    } else if (this.opts.trackTitleChanges && (titleChanged || urlChanged)) {
      // Same app, different window/tab
      this.current = snapshot;
      this.emit('context:same-app', {
        previous,
        current: snapshot,
        sameApp: true,
        previousDurationMs,
      });
    }
  }

  private emitChange(
    previous: ActiveWindow | null,
    current: ActiveWindow,
    now: number,
    previousDurationMs = 0
  ): void {
    this.lastEmitted = current;
    this.lastEmitAt = now;

    log.context.info(
      `context → ${current.app.name}${current.title ? ` — ${truncate(current.title, 60)}` : ''}`
    );

    this.emit('context:changed', {
      previous,
      current,
      sameApp: false,
      previousDurationMs,
    });
  }

  /* ---- Normalization ---------------------------------------------------- */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalize(raw: any): ActiveWindow {
    return {
      title: typeof raw.title === 'string' ? raw.title : '',
      app: {
        name: raw.owner?.name ?? 'Unknown',
        processId: raw.owner?.processId ?? 0,
        bundleId: raw.owner?.bundleId,
        path: raw.owner?.path,
      },
      url: typeof raw.url === 'string' ? raw.url : undefined,
      memoryUsage: typeof raw.memoryUsage === 'number' ? raw.memoryUsage : undefined,
      bounds: raw.bounds,
      capturedAt: Date.now(),
    };
  }

  /* ---- Helpers ---------------------------------------------------------- */

  private isSelf(snapshot: ActiveWindow): boolean {
    const appName = snapshot.app.name.toLowerCase();
    if (appName.includes('jarvis')) return true;

    // On macOS, match our bundle id
    if (process.platform === 'darwin') {
      const ourBundle = process.env.JARVIS_BUNDLE_ID ?? 'com.yourcompany.jarvis';
      return snapshot.app.bundleId === ourBundle;
    }

    // On Windows, Electron apps often report as "electron.exe" in dev
    if (process.platform === 'win32') {
      if (appName === 'electron' && !getMachineInfo().isPackaged) return true;
    }

    return false;
  }

  private checkMacPermissions(): { accessibility: boolean; screenRecording: boolean } {
    let accessibility = false;
    let screenRecording = false;
    try {
      accessibility = systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      /* ignore */
    }
    try {
      screenRecording = systemPreferences.getMediaAccessStatus('screen') === 'granted';
    } catch {
      /* ignore */
    }
    return { accessibility, screenRecording };
  }

  /* ---- Queries ---------------------------------------------------------- */

  /** Current active window snapshot, or null if unknown / no window. */
  getCurrent(): ActiveWindow | null {
    return this.current ? { ...this.current } : null;
  }

  /** How long the current app has been focused (ms). */
  getFocusDurationMs(): number {
    if (!this.current || this.currentSince === 0) return 0;
    return Date.now() - this.currentSince;
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof ContextEvents>(event: K, payload: ContextEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ContextEvents>(
    event: K,
    listener: (payload: ContextEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isWayland(): boolean {
  // XDG_SESSION_TYPE is the most reliable signal on modern distros
  const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase();
  if (sessionType === 'wayland') return true;

  // Fallback: WAYLAND_DISPLAY is set when running under a compositor
  if (process.env.WAYLAND_DISPLAY) return true;

  // Also treat missing DISPLAY as a sign we can't use X11
  if (sessionType === 'x11') return false;
  return !process.env.DISPLAY;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                  */
/* -------------------------------------------------------------------------- */

let instance: ContextDetector | null = null;

export function initContextDetector(opts: ContextDetectorOptions = {}): ContextDetector {
  if (instance) return instance;
  instance = new ContextDetector(opts);
  return instance;
}

export function getContextDetector(): ContextDetector {
  if (!instance) throw new Error('ContextDetector not initialized');
  return instance;
}
