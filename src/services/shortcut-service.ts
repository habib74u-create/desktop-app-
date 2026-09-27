// src/services/shortcut-service.ts
import { globalShortcut } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getJarvisCore } from '../core/jarvis-core';

export interface ShortcutEvents {
  'hotkey:pressed': { accelerator: string };
  'hotkey:released': { accelerator: string };
  'hotkey:changed': { from: string; to: string };
}

export class ShortcutService extends EventEmitter {
  private current = '';
  private registered = new Set<string>();

  init(): void {
    log.services.info('shortcut-service ready');
  }

  /** Register a single push-to-talk accelerator (e.g. 'Fn', 'CommandOrControl+Shift+J'). */
  rebind(accelerator: string): void {
    if (accelerator === this.current && this.isRegistered(accelerator)) return;

    // Unregister previous
    if (this.current) {
      try {
        globalShortcut.unregister(this.current);
      } catch {
        /* ignore */
      }
      this.registered.delete(this.current);
    }

    const from = this.current;
    this.current = accelerator;

    if (!accelerator) {
      this.emit('hotkey:changed', { from, to: '' });
      return;
    }

    // Special case: Fn key on macOS — handled by native module, not globalShortcut
    if (accelerator === 'Fn' && process.platform === 'darwin') {
      log.services.info('Fn key handled by native fn_key_monitor.mm');
      this.emit('hotkey:changed', { from, to: accelerator });
      return;
    }

    const ok = globalShortcut.register(accelerator, () => {
      this.emit('hotkey:pressed', { accelerator });
      const core = getJarvisCore();
      if (core.getState() === 'idle') {
        core.setState('listening', 'hotkey');
      }
    });

    if (!ok) {
      log.services.error(`failed to register hotkey: ${accelerator}`);
      throw new Error(`Hotkey unavailable: ${accelerator}`);
    }

    // Also try to detect release via a second binding (best-effort)
    // Note: Electron's globalShortcut does NOT emit keyup — for true PTT you
    // need native monitoring (see src/input/push-to-talk-refactored.ts).
    this.registered.add(accelerator);
    this.emit('hotkey:changed', { from, to: accelerator });
    log.services.info(`hotkey bound: ${accelerator}`);
  }

  /** Register additional one-shot shortcuts (e.g. Ctrl+Shift+L to toggle overlay). */
  register(accelerator: string, handler: () => void): boolean {
    if (this.registered.has(accelerator)) return true;
    const ok = globalShortcut.register(accelerator, handler);
    if (ok) this.registered.add(accelerator);
    else log.services.warn(`failed to register extra shortcut: ${accelerator}`);
    return ok;
  }

  unregister(accelerator: string): void {
    if (!this.registered.has(accelerator)) return;
    globalShortcut.unregister(accelerator);
    this.registered.delete(accelerator);
  }

  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator) || globalShortcut.isRegistered(accelerator);
  }

  getCurrent(): string {
    return this.current;
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.registered.clear();
    this.current = '';
    log.services.info('shortcut-service disposed');
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof ShortcutEvents>(event: K, payload: ShortcutEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ShortcutEvents>(
    event: K,
    listener: (payload: ShortcutEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

let instance: ShortcutService | null = null;
export function initShortcutService(): ShortcutService {
  if (instance) return instance;
  instance = new ShortcutService();
  return instance;
}
export function getShortcutService(): ShortcutService {
  if (!instance) throw new Error('ShortcutService not initialized');
  return instance;
}
