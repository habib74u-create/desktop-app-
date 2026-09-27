// src/core/jarvis-core.ts
import { EventEmitter } from 'events';
import { log } from './logger';
import { getMachineInfo, machineSummary } from './machine-arch';

export type JarvisState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'responding'
  | 'error';

export interface JarvisEventMap {
  'state:changed': { from: JarvisState; to: JarvisState; reason?: string };
  'transcript:partial': { text: string };
  'transcript:final': { text: string; durationMs: number };
  'response:chunk': { text: string };
  'response:final': { text: string; tokens: number };
  'error': { scope: string; message: string; cause?: unknown };
  'nudge': { kind: string; payload: unknown };
  'shutdown': void;
}

export interface JarvisConfig {
  /** Wake-word / hotkey enabled */
  hotkeyEnabled: boolean;
  /** Auto-paste into frontmost app */
  autoPaste: boolean;
  /** Transcription language ('auto' for detection) */
  language: string;
  /** Prefer local (Whisper/Sherpa) over cloud */
  preferLocal: boolean;
  /** Analytics opt-in */
  analyticsEnabled: boolean;
  /** UI sound effects */
  soundsEnabled: boolean;
}

const DEFAULT_CONFIG: JarvisConfig = {
  hotkeyEnabled: true,
  autoPaste: true,
  language: 'auto',
  preferLocal: true,
  analyticsEnabled: false,
  soundsEnabled: true,
};

/**
 * JarvisCore is a typed event bus + state machine.
 *
 * It does NOT do the actual work — services and agents do.
 * It coordinates them, tracks state, and emits events.
 */
export class JarvisCore extends EventEmitter {
  private state: JarvisState = 'idle';
  private config: JarvisConfig;
  private startedAt: number | null = null;
  private lastError: { scope: string; message: string; ts: number } | null = null;

  constructor(config: Partial<JarvisConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.setMaxListeners(50);
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.startedAt !== null) {
      log.main.warn('JarvisCore.start() called twice — ignoring');
      return;
    }
    this.startedAt = Date.now();
    const machine = getMachineInfo();
    log.main.info(`JarvisCore starting · ${machineSummary()}`);
    log.main.debug('machine info', machine);

    // Sub-systems get wired by main.ts calling registerX() below
    this.transition('idle', 'startup');
  }

  async stop(): Promise<void> {
    if (this.startedAt === null) return;
    log.main.info('JarvisCore stopping');
    this.emit('shutdown');
    this.removeAllListeners();
    this.startedAt = null;
  }

  isRunning(): boolean {
    return this.startedAt !== null;
  }

  uptimeMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /* ---------------------------------------------------------------------- */
  /* State machine                                                          */
  /* ---------------------------------------------------------------------- */

  getState(): JarvisState {
    return this.state;
  }

  /**
   * Transition to a new state.
   * Emits `state:changed`. Returns false if rejected by the transition table.
   */
  setState(to: JarvisState, reason?: string): boolean {
    if (to === this.state) return true;
    if (!this.canTransition(this.state, to)) {
      log.main.warn(`illegal state transition ${this.state} → ${to} (${reason ?? 'no reason'})`);
      return false;
    }
    const from = this.state;
    this.state = to;
    log.main.debug(`state ${from} → ${to}${reason ? ` (${reason})` : ''}`);
    this.emit('state:changed', { from, to, reason });
    return true;
  }

  private transition(to: JarvisState, reason?: string): void {
    // internal — bypasses the transition table for startup/shutdown
    const from = this.state;
    this.state = to;
    this.emit('state:changed', { from, to, reason });
  }

  /**
   * Legal transitions:
   *   idle        → listening | thinking | error
   *   listening   → transcribing | idle | error
   *   transcribing→ thinking    | idle | error
   *   thinking    → responding  | idle | error
   *   responding  → idle        | error
   *   error       → idle
   */
  private canTransition(from: JarvisState, to: JarvisState): boolean {
    if (to === 'error') return true;
    if (from === 'error' && to === 'idle') return true;
    const table: Record<JarvisState, JarvisState[]> = {
      idle: ['listening', 'thinking', 'error'],
      listening: ['transcribing', 'idle', 'error'],
      transcribing: ['thinking', 'idle', 'error'],
      thinking: ['responding', 'idle', 'error'],
      responding: ['idle', 'error'],
      error: ['idle'],
    };
    return table[from].includes(to);
  }

  /* ---------------------------------------------------------------------- */
  /* Config                                                                 */
  /* ---------------------------------------------------------------------- */

  getConfig(): Readonly<JarvisConfig> {
    return { ...this.config };
  }

  updateConfig(patch: Partial<JarvisConfig>): void {
    this.config = { ...this.config, ...patch };
    log.main.info('config updated', patch);
    this.emit('state:changed', { from: this.state, to: this.state, reason: 'config' });
  }

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                 */
  /* ---------------------------------------------------------------------- */

  reportError(scope: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = { scope, message, ts: Date.now() };
    log.main.error(`[${scope}] ${message}`, err);
    this.setState('error', `${scope}: ${message}`);
    this.emit('error', { scope, message, cause: err });
  }

  getLastError(): { scope: string; message: string; ts: number } | null {
    return this.lastError;
  }

  clearError(): void {
    this.lastError = null;
    if (this.state === 'error') this.setState('idle', 'error cleared');
  }

  /* ---------------------------------------------------------------------- */
  /* Typed emit/on                                                          */
  /* ---------------------------------------------------------------------- */

  override emit<K extends keyof JarvisEventMap>(
    event: K,
    payload: JarvisEventMap[K]
  ): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof JarvisEventMap>(
    event: K,
    listener: (payload: JarvisEventMap[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends keyof JarvisEventMap>(
    event: K,
    listener: (payload: JarvisEventMap[K]) => void
  ): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }
}

/** Singleton — created in main.ts and imported by services. */
let instance: JarvisCore | null = null;

export function initJarvisCore(config: Partial<JarvisConfig> = {}): JarvisCore {
  if (instance) return instance;
  instance = new JarvisCore(config);
  return instance;
}

export function getJarvisCore(): JarvisCore {
  if (!instance) throw new Error('JarvisCore not initialized — call initJarvisCore() first');
  return instance;
}

export function destroyJarvisCore(): void {
  instance = null;
}