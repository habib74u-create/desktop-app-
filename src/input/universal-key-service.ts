// src/input/universal-key-service.ts
import { EventEmitter } from 'events';
import { globalShortcut } from 'electron';
import { log } from '../core/logger';
import { getMachineInfo } from '../core/machine-arch';

export type KeyState = 'down' | 'up';

export interface KeyEvent {
  /** Normalized key name, e.g. "F9", "LEFT META", "SPACE" */
  name: string;
  state: KeyState;
  /** Raw key name from the OS */
  raw: string;
  /** Map of all currently-held keys at the time of this event */
  heldKeys: Record<string, boolean>;
}

export interface UniversalKeyEvents {
  'key:down': KeyEvent;
  'key:up': KeyEvent;
  'ptt:start': void;
  'ptt:stop': void;
  'listener:error': { message: string; fatal: boolean };
  'listener:fallback': { reason: string };
}

/** A PTT binding: one or more keys that must be held simultaneously. */
export interface PttBinding {
  /** Normalized key names that must all be down, e.g. ['F9'] or ['LEFT CTRL', 'SPACE'] */
  keys: string[];
  /** If true, this binding is currently armed */
  enabled: boolean;
}

export class UniversalKeyService extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listener: any = null;
  private heldKeys: Record<string, boolean> = {};
  private binding: PttBinding = { keys: [], enabled: false };
  private pttActive = false;
  private fallbackMode = false;
  private fallbackAccelerator = '';
  private started = false;

  /* ---- Lifecycle -------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      await this.startNativeListener();
      log.input.info('universal-key-service: native listener active');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.input.warn(`native listener failed: ${msg}`);
      this.emit('listener:error', { message: msg, fatal: false });
      this.enableFallback('native listener unavailable');
    }
  }

  stop(): void {
    if (this.listener) {
      try {
        this.listener.removeAllListeners?.();
      } catch {
        /* ignore */
      }
      this.listener = null;
    }
    if (this.fallbackAccelerator) {
      try {
        globalShortcut.unregister(this.fallbackAccelerator);
      } catch {
        /* ignore */
      }
      this.fallbackAccelerator = '';
    }
    this.heldKeys = {};
    this.pttActive = false;
    this.started = false;
    log.input.info('universal-key-service stopped');
  }

  /* ---- Native listener (node-global-key-listener) ----------------------- */

  private async startNativeListener(): Promise<void> {
    // Lazy require so the app doesn't crash if the native binary is missing
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { GlobalKeyboardListener } = require('node-global-key-listener');

    const machine = getMachineInfo();

    // On Windows, provide error handlers that surface antivirus blocks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {};
    if (machine.platform === 'win32') {
      opts.windows = {
        onError: (code: number) => {
          log.input.error(`WinKeyServer error code: ${code}`);
          this.emit('listener:error', { message: `WinKeyServer error ${code}`, fatal: true });
          this.enableFallback('WinKeyServer error');
        },
        onInfo: (info: string) => log.input.debug(`WinKeyServer: ${info}`),
      };
    }

    this.listener = new GlobalKeyboardListener(opts);

    this.listener.addListener((e: { name: string; state: string; rawKey: { _nameRaw: string } }, down: Record<string, boolean>) => {
      // CRITICAL: keep this callback microscopic [citation:4].
      // No logging, no allocation, no locks. Just emit.
      const name = normalizeKeyName(e.name);
      const state: KeyState = e.state === 'DOWN' ? 'down' : 'up';

      // Update held-key table
      if (state === 'down') this.heldKeys[name] = true;
      else delete this.heldKeys[name];

      const event: KeyEvent = {
        name,
        state,
        raw: e.rawKey?._nameRaw ?? name,
        heldKeys: { ...this.heldKeys },
      };

      if (state === 'down') this.emit('key:down', event);
      else this.emit('key:up', event);

      // PTT evaluation
      if (state === 'down') this.evaluatePttDown();
      else this.evaluatePttUp();

      // Return true to consume the event (prevents it from reaching other apps)
      // Return false to let it pass through. We return false for PTT keys
      // so typing still works; the hook just observes.
      return false;
    });

    log.input.info('node-global-key-listener initialized');
  }

  /* ---- Fallback (globalShortcut toggle) --------------------------------- */

  private enableFallback(reason: string): void {
    if (this.fallbackMode) return;
    this.fallbackMode = true;
    this.emit('listener:fallback', { reason });
    log.input.warn(`falling back to toggle mode: ${reason}`);

    // Register a toggle accelerator (default: CommandOrControl+Shift+Space)
    const accel = process.env.JARVIS_PTT_FALLBACK_ACCELERATOR ?? 'CommandOrControl+Shift+Space';
    const ok = globalShortcut.register(accel, () => {
      if (this.pttActive) {
        this.pttActive = false;
        this.emit('ptt:stop');
        log.input.debug('PTT stop (toggle fallback)');
      } else {
        this.pttActive = true;
        this.emit('ptt:start');
        log.input.debug('PTT start (toggle fallback)');
      }
    });

    if (ok) {
      this.fallbackAccelerator = accel;
      log.input.info(`fallback PTT toggle bound to ${accel}`);
    } else {
      log.input.error(`failed to bind fallback accelerator ${accel}`);
    }
  }

  /* ---- PTT binding ------------------------------------------------------ */

  /**
   * Bind a PTT chord. `keys` are normalized names (e.g. ['F9'], ['LEFT CTRL', 'SPACE']).
   */
  bindPtt(keys: string[]): void {
    this.binding = { keys: keys.map(normalizeKeyName), enabled: true };
    log.input.info(`PTT bound to: ${this.binding.keys.join(' + ')}`);
  }

  unbindPtt(): void {
    this.binding.enabled = false;
    if (this.pttActive) {
      this.pttActive = false;
      this.emit('ptt:stop');
    }
    log.input.info('PTT unbound');
  }

  isPttActive(): boolean {
    return this.pttActive;
  }

  /* ---- PTT evaluation --------------------------------------------------- */

  private evaluatePttDown(): void {
    if (this.fallbackMode) return; // fallback uses toggle
    if (!this.binding.enabled || this.binding.keys.length === 0) return;

    // All bound keys must be down simultaneously
    const allDown = this.binding.keys.every((k) => this.heldKeys[k] === true);
    if (allDown && !this.pttActive) {
      this.pttActive = true;
      this.emit('ptt:start');
      log.input.debug(`PTT start (${this.binding.keys.join('+')})`);
    }
  }

  private evaluatePttUp(): void {
    if (this.fallbackMode) return;
    if (!this.pttActive) return;

    // Any bound key released → stop
    const anyUp = this.binding.keys.some((k) => this.heldKeys[k] !== true);
    if (anyUp) {
      this.pttActive = false;
      this.emit('ptt:stop');
      log.input.debug('PTT stop');
    }
  }

  /* ---- Renderer-side PTT (Chromium hook workaround) [citation:4] -------- */

  /**
   * Called when the renderer detects keydown for the PTT key.
   * This works around the Windows bug where WH_KEYBOARD_LL hooks go deaf
   * while a Chromium window is focused.
   */
  handleRendererPttDown(): void {
    if (this.pttActive) return;
    this.pttActive = true;
    this.emit('ptt:start');
    log.input.debug('PTT start (renderer-side)');
  }

  handleRendererPttUp(): void {
    if (!this.pttActive) return;
    this.pttActive = false;
    this.emit('ptt:stop');
    log.input.debug('PTT stop (renderer-side)');
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof UniversalKeyEvents>(event: K, payload: UniversalKeyEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof UniversalKeyEvents>(
    event: K,
    listener: (payload: UniversalKeyEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

/* -------------------------------------------------------------------------- */
/* Key name normalization                                                     */
/* -------------------------------------------------------------------------- */

/**
 * node-global-key-listener returns OS-specific names.
 * Normalize to a stable cross-platform set.
 */
function normalizeKeyName(raw: string): string {
  const upper = raw.toUpperCase().trim();

  // Function keys: F1..F24 — already correct
  if (/^F\d{1,2}$/.test(upper)) return upper;

  // Modifiers
  const modifierMap: Record<string, string> = {
    'LEFT CTRL': 'LEFT CTRL',
    'RIGHT CTRL': 'RIGHT CTRL',
    'LEFT ALT': 'LEFT ALT',
    'RIGHT ALT': 'RIGHT ALT',
    'LEFT SHIFT': 'LEFT SHIFT',
    'RIGHT SHIFT': 'RIGHT SHIFT',
    'LEFT META': 'LEFT META',
    'RIGHT META': 'RIGHT META',
    'LEFT WIN': 'LEFT META',
    'RIGHT WIN': 'RIGHT META',
    'LEFT CMD': 'LEFT META',
    'RIGHT CMD': 'RIGHT META',
    'LEFT OPTION': 'LEFT ALT',
    'RIGHT OPTION': 'RIGHT ALT',
  };
  if (modifierMap[upper]) return modifierMap[upper];

  // Common aliases
  const aliasMap: Record<string, string> = {
    ESC: 'ESCAPE',
    RETURN: 'ENTER',
    SPACEBAR: 'SPACE',
    ' ': 'SPACE',
  };
  if (aliasMap[upper]) return aliasMap[upper];

  return upper;
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                  */
/* -------------------------------------------------------------------------- */

let instance: UniversalKeyService | null = null;

export function initUniversalKeyService(): UniversalKeyService {
  if (instance) return instance;
  instance = new UniversalKeyService();
  return instance;
}

export function getUniversalKeyService(): UniversalKeyService {
  if (!instance) throw new Error('UniversalKeyService not initialized');
  return instance;
}
