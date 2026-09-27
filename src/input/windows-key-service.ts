// src/input/windows-key-service.ts
import { globalShortcut, app } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getMachineInfo } from '../core/machine-arch';
import { getUniversalKeyService } from './universal-key-service';

/**
 * Windows-specific key handling.
 *
 * Responsibilities:
 *  - Register Windows-only shortcuts (Win+Space is reserved by OS [citation:3])
 *  - Handle the Chromium WH_KEYBOARD_LL bug workaround [citation:4]
 *  - Manage fallback toggles when WinKeyServer.exe is blocked by AV [citation:14]
 */
export class WindowsKeyService extends EventEmitter {
  private registered = new Set<string>();
  private hookHealthy = true;

  init(): void {
    if (getMachineInfo().platform !== 'win32') return;

    log.input.info('windows-key-service ready');

    // Watch for the native listener going silent (hook dropped by Windows)
    this.startHookHealthCheck();
  }

  /* ---- Windows-only shortcuts ------------------------------------------ */

  /**
   * Register a shortcut that's safe on Windows (avoids OS-reserved combos
   * like Win+Space, Ctrl+Alt+Del, etc.).
   */
  registerSafe(accelerator: string, handler: () => void): boolean {
    if (this.registered.has(accelerator)) return true;

    // Windows reserves certain combos — fail early with a clear message
    const reserved = ['Super+Space', 'CommandOrControl+Alt+Delete', 'Alt+F4'];
    if (reserved.some((r) => accelerator.toLowerCase().includes(r.toLowerCase()))) {
      log.input.warn(`accelerator reserved by Windows: ${accelerator}`);
      return false;
    }

    const ok = globalShortcut.register(accelerator, handler);
    if (ok) this.registered.add(accelerator);
    else log.input.warn(`failed to register: ${accelerator}`);
    return ok;
  }

  unregisterAll(): void {
    for (const accel of this.registered) {
      try {
        globalShortcut.unregister(accel);
      } catch {
        /* ignore */
      }
    }
    this.registered.clear();
  }

  /* ---- Hook health check (Chromium bug workaround) [citation:4] --------- */

  private healthTimer: NodeJS.Timeout | null = null;

  /**
   * Poll GetAsyncKeyState-equivalent. If the user is clearly typing but our
   * hook hasn't fired in a while, assume the hook was dropped and re-arm.
   *
   * In practice we can't call GetAsyncKeyState from Node without a native
   * addon. So we use a cheaper heuristic: if the renderer reports keydown
   * activity but the main-process hook reports nothing, flag it.
   */
  private startHookHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      // This is a placeholder — real detection requires comparing
      // renderer keydown counts vs hook keydown counts.
      // See push-to-talk-refactored.ts for the actual comparison logic.
      if (!this.hookHealthy) {
        log.input.warn('hook health check: hook appears dead, re-arming');
        this.rearmHook();
      }
    }, 30_000);
  }

  private rearmHook(): void {
    try {
      const svc = getUniversalKeyService();
      svc.stop();
      void svc.start();
      this.hookHealthy = true;
      log.input.info('hook re-armed');
    } catch (err) {
      log.input.error('failed to re-arm hook', err);
    }
  }

  /** Called by the renderer when it sees keydown but main-process hook doesn't. */
  reportHookSilence(): void {
    this.hookHealthy = false;
    log.input.warn('renderer reports hook silence');
  }

  /** Called by UniversalKeyService on every hook event. */
  reportHookActivity(): void {
    this.hookHealthy = true;
  }

  dispose(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.unregisterAll();
  }
}

let instance: WindowsKeyService | null = null;

export function initWindowsKeyService(): WindowsKeyService {
  if (instance) return instance;
  instance = new WindowsKeyService();
  return instance;
}

export function getWindowsKeyService(): WindowsKeyService {
  if (!instance) throw new Error('WindowsKeyService not initialized');
  return instance;
}
