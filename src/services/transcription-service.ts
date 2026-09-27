// src/services/transcription-service.ts
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getJarvisCore } from '../core/jarvis-core';
import { getAppSettingsService } from './app-settings-service';
import { getSecureApiService } from './secure-api-service';

export interface TranscriptionResult {
  text: string;
  language: string;
  durationMs: number;
  engine: 'whisper-local' | 'sherpa-local' | 'cloud';
}

export interface TranscriptionEvents {
  'partial': { text: string };
  'final': TranscriptionResult;
  'error': { message: string; cause?: unknown };
}

/** Pluggable engine interface. */
export interface TranscriptionEngine {
  readonly name: TranscriptionResult['engine'];
  init(): Promise<void>;
  dispose(): Promise<void>;
  /** Transcribe a PCM buffer or a file path. */
  transcribe(input: { path?: string; pcm?: Float32Array; sampleRate?: number }): Promise<TranscriptionResult>;
  /** Streaming variant (optional). */
  startStream?(onPartial: (text: string) => void): Promise<{ stop: () => Promise<TranscriptionResult> }>;
}

export class TranscriptionService extends EventEmitter {
  private engine: TranscriptionEngine | null = null;
  private busy = false;

  init(): void {
    log.services.info('transcription-service ready');
  }

  /* ---- Engine selection ------------------------------------------------- */

  async useEngine(engine: TranscriptionEngine): Promise<void> {
    if (this.engine) {
      await this.engine.dispose().catch((err) => log.services.error('engine dispose failed', err));
    }
    await engine.init();
    this.engine = engine;
    log.services.info(`transcription engine: ${engine.name}`);
  }

  getEngineName(): string {
    return this.engine?.name ?? 'none';
  }

  /* ---- Transcribe ------------------------------------------------------- */

  async transcribe(input: {
    path?: string;
    pcm?: Float32Array;
    sampleRate?: number;
  }): Promise<TranscriptionResult> {
    if (this.busy) throw new Error('transcription already in progress');
    if (!this.engine) throw new Error('no transcription engine configured');

    this.busy = true;
    const core = getJarvisCore();
    const previous = core.getState();
    core.setState('transcribing', 'transcription-start');

    try {
      const result = await this.engine.transcribe(input);
      core.setState('idle', 'transcription-done');
      this.emit('final', result);
      log.transcription.info(`transcribed ${result.text.length} chars in ${result.durationMs}ms`);
      return result;
    } catch (err) {
      core.setState('error', 'transcription-failed');
      this.emit('error', { message: (err as Error).message, cause: err });
      throw err;
    } finally {
      this.busy = false;
      // Restore state if engine threw before we set idle
      if (core.getState() === 'error' && previous === 'idle') {
        // leave in error until user acts
      }
    }
  }

  /* ---- Streaming (optional) --------------------------------------------- */

  async startStream(onPartial?: (text: string) => void): Promise<{ stop: () => Promise<TranscriptionResult> }> {
    if (!this.engine?.startStream) {
      throw new Error('current engine does not support streaming');
    }
    const stream = await this.engine.startStream((text) => {
      this.emit('partial', { text });
      onPartial?.(text);
    });
    return stream;
  }

  /* ---- Cloud fallback --------------------------------------------------- */

  async transcribeCloud(audioPath: string, language: string): Promise<TranscriptionResult> {
    const api = getSecureApiService();
    const settings = getAppSettingsService().get();
    const res = await api.request<{ text: string; language: string }>('/transcribe', {
      method: 'POST',
      body: JSON.stringify({ path: audioPath, language }),
    });
    const result: TranscriptionResult = {
      text: res.text,
      language: res.language,
      durationMs: 0,
      engine: 'cloud',
    };
    this.emit('final', result);
    return result;
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof TranscriptionEvents>(event: K, payload: TranscriptionEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof TranscriptionEvents>(
    event: K,
    listener: (payload: TranscriptionEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

let instance: TranscriptionService | null = null;
export function initTranscriptionService(): TranscriptionService {
  if (instance) return instance;
  instance = new TranscriptionService();
  return instance;
}
export function getTranscriptionService(): TranscriptionService {
  if (!instance) throw new Error('TranscriptionService not initialized');
  return instance;
}
