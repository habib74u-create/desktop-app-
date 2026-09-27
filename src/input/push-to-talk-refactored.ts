// src/input/push-to-talk-refactored.ts
import { ipcMain, BrowserWindow, systemPreferences } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getJarvisCore } from '../core/jarvis-core';
import { getAppSettingsService } from '../services/app-settings-service';
import { getTranscriptionService } from '../services/transcription-service';
import { getUniversalKeyService } from './universal-key-service';
import { getWindowsKeyService } from './windows-key-service';
import { CH } from '../ipc/ipc-types';
import { emitToAll } from '../ipc/ipc-handlers';

export interface PttEvents {
  'recording:start': void;
  'recording:stop': { durationMs: number };
  'recording:cancelled': void;
  'transcript:ready': { text: string };
  'error': { message: string };
}

export class PushToTalkController extends EventEmitter {
  private recording = false;
  private recordingStartedAt = 0;
  private minDurationMs = 250; // ignore taps shorter than this

  init(): void {
    const keys = getUniversalKeyService();
    const core = getJarvisCore();
    const settings = getAppSettingsService().get();

    // Bind the user's configured PTT chord
    const binding = parsePttBinding(settings.hotkey);
    keys.bindPtt(binding);

    // Wire PTT events → recording lifecycle
    keys.on('ptt:start', () => this.handlePttStart());
    keys.on('ptt:stop', () => this.handlePttStop());
    keys.on('listener:error', ({ message, fatal }) => {
      log.input.error(`key listener error: ${message}`);
      if (fatal) this.emit('error', { message });
    });

    // Core state → recording gate
    core.on('state:changed', ({ to }) => {
      if (to !== 'listening' && this.recording) {
        log.input.warn(`core left listening state while recording — cancelling`);
        this.cancel();
      }
    });

    // Renderer-side fallback (Chromium hook bug) [citation:4]
    this.installRendererFallback();

    log.input.info(`PTT controller ready (binding: ${binding.join('+')})`);
  }

  dispose(): void {
    const keys = getUniversalKeyService();
    keys.unbindPtt();
    keys.removeAllListeners('ptt:start');
    keys.removeAllListeners('ptt:stop');
  }

  /* ---- PTT lifecycle ---------------------------------------------------- */

  private handlePttStart(): void {
    if (this.recording) return;
    if (!this.checkMicrophonePermission()) {
      log.input.warn('PTT blocked: microphone permission not granted');
      this.emit('error', { message: 'Microphone permission required' });
      return;
    }

    const core = getJarvisCore();
    if (core.getState() !== 'idle' && core.getState() !== 'listening') {
      log.input.debug(`PTT ignored: core state is ${core.getState()}`);
      return;
    }

    this.recording = true;
    this.recordingStartedAt = Date.now();
    core.setState('listening', 'ptt-start');
    emitToAll(CH.dictationState, { state: 'listening' });
    this.emit('recording:start');

    log.input.debug('recording started');
  }

  private async handlePttStop(): Promise<void> {
    if (!this.recording) return;
    const duration = Date.now() - this.recordingStartedAt;
    this.recording = false;

    if (duration < this.minDurationMs) {
      log.input.debug(`PTT tap ignored (${duration}ms < ${this.minDurationMs}ms)`);
      getJarvisCore().setState('idle', 'ptt-too-short');
      emitToAll(CH.dictationState, { state: 'idle' });
      return;
    }

    this.emit('recording:stop', { durationMs: duration });
    emitToAll(CH.dictationState, { state: 'transcribing' });

    // Transcription is handled by dictation-ipc-handlers.ts via the
    // dictation:stop channel. This controller just owns the PTT gate.
    log.input.debug(`recording stopped (${duration}ms)`);
  }

  cancel(): void {
    if (!this.recording) return;
    this.recording = false;
    getJarvisCore().setState('idle', 'ptt-cancel');
    emitToAll(CH.dictationState, { state: 'idle' });
    this.emit('recording:cancelled');
    log.input.debug('recording cancelled');
  }

  isRecording(): boolean {
    return this.recording;
  }

  /* ---- Renderer-side fallback ------------------------------------------ */

  /**
   * On Windows, WH_KEYBOARD_LL hooks can go silent while a Chromium window
   * is focused [citation:4]. The workaround: let the renderer detect keydown
   * and keyup for the PTT chord itself, and forward them to main.
   *
   * The renderer sends:
   *   CH.pttRendererDown  → when PTT key pressed while Jarvis has focus
   *   CH.pttRendererUp    → when PTT key released while Jarvis has focus
   *
   * Main process:
   *   - Uses renderer signal if the hook is silent
   *   - Uses hook signal if renderer isn't focused
   */
  private installRendererFallback(): void {
    const keys = getUniversalKeyService();

    ipcMain.on(CH.pttRendererDown, () => {
      if (getWindowsKeyService()) {
        // Only use renderer signal if the hook is known to be silent
        if (!keys.isPttActive()) {
          keys.handleRendererPttDown();
        }
      }
    });

    ipcMain.on(CH.pttRendererUp, () => {
      if (keys.isPttActive()) {
        keys.handleRendererPttUp();
      }
    });
  }

  /* ---- Permission check ------------------------------------------------- */

  private checkMicrophonePermission(): boolean {
    if (process.platform !== 'darwin') return true;
    try {
      return systemPreferences.getMediaAccessStatus('microphone') === 'granted';
    } catch {
      return true;
    }
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof PttEvents>(event: K, payload: PttEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof PttEvents>(
    event: K,
    listener: (payload: PttEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

/* -------------------------------------------------------------------------- */
/* Binding parser                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse a hotkey string into normalized key names.
 * Examples:
 *   "Fn"              → ["FN"]
 *   "F9"              → ["F9"]
 *   "CommandOrControl+Shift+Space" → ["LEFT META", "LEFT SHIFT", "SPACE"] (mac)
 *                                  → ["LEFT CTRL", "LEFT SHIFT", "SPACE"] (win/linux)
 */
export function parsePttBinding(hotkey: string): string[] {
  if (!hotkey) return ['F9'];

  // Special case: Fn key on macOS — handled by native fn_key_monitor.mm
  if (hotkey === 'Fn') return ['FN'];

  const isMac = process.platform === 'darwin';
  const parts = hotkey.split('+').map((p) => p.trim());

  return parts.map((p) => {
    switch (p) {
      case 'CommandOrControl':
      case 'CmdOrCtrl':
        return isMac ? 'LEFT META' : 'LEFT CTRL';
      case 'Command':
      case 'Cmd':
      case 'Meta':
        return 'LEFT META';
      case 'Control':
      case 'Ctrl':
        return 'LEFT CTRL';
      case 'Alt':
      case 'Option':
        return isMac ? 'LEFT ALT' : 'LEFT ALT';
      case 'Shift':
        return 'LEFT SHIFT';
      default:
        return p.toUpperCase();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                  */
/* -------------------------------------------------------------------------- */

let instance: PushToTalkController | null = null;

export function initPushToTalkController(): PushToTalkController {
  if (instance) return instance;
  instance = new PushToTalkController();
  instance.init();
  return instance;
}

export function getPushToTalkController(): PushToTalkController {
  if (!instance) throw new Error('PushToTalkController not initialized');
  return instance;
}
