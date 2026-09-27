/**
 * Windows Key Service
 *
 * Windows has no OS-level "Fn key" event (it's trapped by the keyboard's
 * hardware/firmware before it ever reaches the OS), so the Mac app's
 * Fn-key push-to-talk trigger has no direct equivalent here. Instead this
 * listens for a configurable regular key (default: Right Ctrl) using
 * uiohook-napi, which ships prebuilt native binaries for Windows — no
 * node-gyp compile step required, so it builds reliably in CI.
 *
 * Mirrors UniversalKeyService's public interface (constructor, start,
 * stop) so main.ts only needs a platform check to pick between them.
 */
import { Logger } from '../core/logger';

// uiohook key codes for common push-to-talk trigger keys.
const KEY_CODES: Record<string, number> = {
  right_ctrl: 3613,
  right_alt: 3640,
  right_shift: 54,
  option: 3640,  // Windows has no "Option" key — maps to Right Alt
  fn: 3613,      // no real Fn code on Windows — falls back to Right Ctrl
};

export class WindowsKeyService {
  private uIOhook: any = null;
  private isActive = false;
  private onKeyDown: (() => void) | null = null;
  private onKeyUp: (() => void) | null = null;
  private triggerKeyCode = KEY_CODES.right_ctrl;
  private isKeyCurrentlyDown = false;

  constructor(onKeyDown: () => void, onKeyUp: () => void) {
    this.onKeyDown = onKeyDown;
    this.onKeyUp = onKeyUp;
  }

  start(keyName: string = 'right_ctrl'): boolean {
    if (this.isActive) {
      Logger.info('[WindowsKeyService] Already running');
      return false;
    }

    this.triggerKeyCode = KEY_CODES[keyName] ?? KEY_CODES.right_ctrl;

    try {
      // Loaded lazily so the rest of the app still works if the package
      // is ever missing — only this push-to-talk feature is affected.
      const nodeRequire = eval('require');
      const mod = nodeRequire('uiohook-napi');
      this.uIOhook = mod.uIOhook;

      this.uIOhook.on('keydown', (e: { keycode: number }) => {
        if (e.keycode === this.triggerKeyCode && !this.isKeyCurrentlyDown) {
          this.isKeyCurrentlyDown = true;
          this.onKeyDown?.();
        }
      });

      this.uIOhook.on('keyup', (e: { keycode: number }) => {
        if (e.keycode === this.triggerKeyCode && this.isKeyCurrentlyDown) {
          this.isKeyCurrentlyDown = false;
          this.onKeyUp?.();
        }
      });

      this.uIOhook.start();
      this.isActive = true;
      Logger.success(`[WindowsKeyService] Push-to-talk monitoring started (key: ${keyName})`);
      return true;
    } catch (error) {
      Logger.error('[WindowsKeyService] Failed to start:', error);
      Logger.error('💡 Make sure uiohook-napi is installed: npm install uiohook-napi');
      return false;
    }
  }

  stop(): void {
    if (!this.isActive || !this.uIOhook) return;
    try {
      this.uIOhook.stop();
      this.isActive = false;
      this.uIOhook = null;
      Logger.info('[WindowsKeyService] Monitoring stopped');
    } catch (error) {
      Logger.error('[WindowsKeyService] Error stopping:', error);
    }
  }
}
