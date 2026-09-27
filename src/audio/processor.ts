// src/audio/processor.ts
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getAppSettingsService } from '../services/app-settings-service';
import { getTranscriptionService } from '../services/transcription-service';
import { SherpaOnlineTranscriber } from '../transcription/sherpa-onnx-transcriber';
import { getNodeDictionary } from '../services/node-dictionary';
import { getJarvisCore } from '../core/jarvis-core';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface AudioChunk {
  /** Mono float32 PCM samples in [-1, 1] */
  samples: Float32Array;
  /** Sample rate of these samples (Hz) */
  sampleRate: number;
  /** Monotonic timestamp (ms since epoch) when the first sample was captured */
  timestamp: number;
}

export interface ProcessorOptions {
  /** Target sample rate for ASR models. Default 16000. */
  targetSampleRate?: number;
  /** RMS threshold below which audio is considered silence. Default 0.008. */
  silenceThreshold?: number;
  /** Minimum speech duration before we start feeding the ASR (ms). Default 250. */
  minSpeechDurationMs?: number;
  /** Trailing silence before we consider the utterance done (ms). Default 400. */
  minSilenceDurationMs?: number;
  /** Maximum utterance length before a forced split (ms). Default 30000. */
  maxUtteranceMs?: number;
  /** Normalize peak amplitude. Default true. */
  normalize?: boolean;
  /** Use streaming recognizer when available. Default true. */
  preferStreaming?: boolean;
}

export interface ProcessorEvents {
  'chunk:accepted': { samples: number; rms: number };
  'chunk:skipped': { reason: 'silence' | 'too-short' };
  'speech:start': void;
  'speech:end': { durationMs: number };
  'transcript:partial': { text: string };
  'transcript:final': { text: string; durationMs: number; engine: string };
  'transcript:error': { message: string };
}

const DEFAULTS: Required<ProcessorOptions> = {
  targetSampleRate: 16000,
  silenceThreshold: 0.008,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 400,
  maxUtteranceMs: 30_000,
  normalize: true,
  preferStreaming: true,
};

/* -------------------------------------------------------------------------- */
/* Processor                                                                  */
/* -------------------------------------------------------------------------- */

export class AudioProcessor extends EventEmitter {
  private opts: Required<ProcessorOptions>;

  /** Accumulated utterance samples (already resampled to targetSampleRate) */
  private buffer: Float32Array[] = [];
  private bufferSampleCount = 0;

  /** State machine */
  private state: 'idle' | 'speech' | 'trailing-silence' = 'idle';
  private speechStartedAt = 0;
  private lastSpeechAt = 0;

  /** Streaming recognizer handle (if in use) */
  private stream: { stop: () => Promise<{ text: string; durationMs: number; engine: string }> } | null = null;
  private streaming = false;

  constructor(opts: ProcessorOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
  }

  /* ---- Lifecycle -------------------------------------------------------- */

  /**
   * Begin a new utterance. Call when PTT is pressed.
   */
  async beginUtterance(): Promise<void> {
    this.reset();
    this.speechStartedAt = Date.now();
    this.lastSpeechAt = this.speechStartedAt;
    this.state = 'idle';

    // Try to open a streaming recognizer if the engine supports it
    if (this.opts.preferStreaming) {
      try {
        const svc = getTranscriptionService();
        const engine = svc.getEngineName();
        if (engine === 'sherpa-local') {
          // The service's streaming path handles this; we just signal the start
          const s = await svc.startStream((text) => {
            this.emit('transcript:partial', { text });
          });
          this.stream = s as unknown as { stop: () => Promise<{ text: string; durationMs: number; engine: string }> };
          this.streaming = true;
          log.audio.debug('streaming recognizer started');
        }
      } catch (err) {
        log.audio.debug('streaming not available, falling back to batch', err);
        this.streaming = false;
      }
    }

    log.audio.debug('utterance begin');
  }

  /**
   * End the current utterance and produce a final transcript.
   * Call when PTT is released.
   */
  async endUtterance(): Promise<string> {
    // Flush any buffered samples
    if (!this.streaming && this.bufferSampleCount > 0) {
      await this.transcribeBuffered();
    }

    let finalText = '';

    if (this.streaming && this.stream) {
      try {
        const result = await this.stream.stop();
        finalText = result.text;
        this.emit('transcript:final', {
          text: finalText,
          durationMs: result.durationMs,
          engine: result.engine,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('transcript:error', { message: msg });
        log.audio.error('streaming stop failed', err);
      }
      this.stream = null;
      this.streaming = false;
    }

    // Apply dictionary replacements + send through paste helper
    if (finalText) {
      finalText = this.applyPostProcessing(finalText);
      await this.handleFinalText(finalText);
    }

    this.reset();
    log.audio.debug(`utterance end (${finalText.length} chars)`);
    return finalText;
  }

  /**
   * Cancel the current utterance without transcribing.
   */
  cancel(): void {
    if (this.stream) {
      try {
        void this.stream.stop();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
    this.reset();
    this.streaming = false;
    log.audio.debug('utterance cancelled');
  }

  /**
   * Feed a raw PCM chunk from the recorder. Non-blocking.
   */
  push(chunk: AudioChunk): void {
    try {
      // Resample to target rate if needed
      const samples =
        chunk.sampleRate === this.opts.targetSampleRate
          ? chunk.samples
          : resampleLinear(chunk.samples, chunk.sampleRate, this.opts.targetSampleRate);

      const rms = computeRms(samples);

      // VAD gate
      const isSpeech = rms >= this.opts.silenceThreshold;
      const now = Date.now();

      if (!isSpeech) {
        // Trailing silence handling
        if (this.state === 'speech') {
          const silenceFor = now - this.lastSpeechAt;
          if (silenceFor >= this.opts.minSilenceDurationMs) {
            // Endpoint detected — emit end but keep buffering until explicit end
            this.state = 'trailing-silence';
            this.emit('speech:end', { durationMs: now - this.speechStartedAt });
          }
        }
        this.emit('chunk:skipped', { reason: 'silence' });
        // Still buffer for context (short trailing silence)
        if (this.state === 'trailing-silence' && now - this.speechStartedAt < this.opts.maxUtteranceMs) {
          this.buffer.push(this.maybeNormalize(samples));
          this.bufferSampleCount += samples.length;
        }
        return;
      }

      // We have speech
      this.lastSpeechAt = now;

      if (this.state === 'idle') {
        // Wait for minSpeechDurationMs before confirming real speech
        const elapsed = now - this.speechStartedAt;
        if (elapsed < this.opts.minSpeechDurationMs) {
          this.buffer.push(this.maybeNormalize(samples));
          this.bufferSampleCount += samples.length;
          this.emit('chunk:skipped', { reason: 'too-short' });
          return;
        }
        this.state = 'speech';
        this.emit('speech:start');
      } else if (this.state === 'trailing-silence') {
        this.state = 'speech';
      }

      const prepared = this.maybeNormalize(samples);

      // Feed streaming recognizer live
      if (this.streaming && this.stream) {
        // sherpa-onnx streaming path — the TranscriptionService owns the stream
        // We can't reach into it here; the service's onPartial callback handles output.
        // For sherpa-onnx specifically, use the `streaming` route via the service.
      } else {
        this.buffer.push(prepared);
        this.bufferSampleCount += prepared.length;
      }

      this.emit('chunk:accepted', { samples: samples.length, rms });

      // Force split on max utterance length
      if (now - this.speechStartedAt >= this.opts.maxUtteranceMs && !this.streaming) {
        void this.transcribeBuffered();
      }
    } catch (err) {
      log.audio.error('processor.push failed', err);
    }
  }

  /* ---- Internals -------------------------------------------------------- */

  private reset(): void {
    this.buffer = [];
    this.bufferSampleCount = 0;
    this.state = 'idle';
    this.speechStartedAt = 0;
    this.lastSpeechAt = 0;
  }

  private maybeNormalize(samples: Float32Array): Float32Array {
    if (!this.opts.normalize) return samples;

    let maxAbs = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs < 0.001) return samples; // too quiet, leave alone
    if (maxAbs > 0.95) return samples; // already near clipping

    const scale = Math.min(0.95 / maxAbs, 1.5);
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = clamp(samples[i] * scale, -1, 1);
    }
    return out;
  }

  private async transcribeBuffered(): Promise<void> {
    if (this.bufferSampleCount === 0) return;

    // Concatenate all buffered chunks
    const merged = new Float32Array(this.bufferSampleCount);
    let offset = 0;
    for (const chunk of this.buffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.buffer = [];
    this.bufferSampleCount = 0;

    try {
      const svc = getTranscriptionService();
      const result = await svc.transcribe({
        pcm: merged,
        sampleRate: this.opts.targetSampleRate,
      });

      let text = result.text;
      text = this.applyPostProcessing(text);

      this.emit('transcript:final', {
        text,
        durationMs: result.durationMs,
        engine: result.engine,
      });

      if (text) await this.handleFinalText(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('transcript:error', { message: msg });
      log.audio.error('batch transcription failed', err);
    }
  }

  private applyPostProcessing(text: string): string {
    try {
      return getNodeDictionary().applyReplacements(text);
    } catch {
      return text;
    }
  }

  private async handleFinalText(text: string): Promise<void> {
    const core = getJarvisCore();
    core.emit('transcript:final', { text, durationMs: 0 });

    // Paste helper is invoked by the dictation IPC layer, not here, to keep
    // concerns separate. This method just logs.
    log.audio.info(`transcript final: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof ProcessorEvents>(event: K, payload: ProcessorEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ProcessorEvents>(
    event: K,
    listener: (payload: ProcessorEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

/* -------------------------------------------------------------------------- */
/* DSP helpers                                                                */
/* -------------------------------------------------------------------------- */

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Linear resampler. Good enough for ASR preprocessing.
 * For production use, consider a polyphase resampler.
 */
function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                  */
/* -------------------------------------------------------------------------- */

let instance: AudioProcessor | null = null;

export function initAudioProcessor(opts: ProcessorOptions = {}): AudioProcessor {
  if (instance) return instance;
  instance = new AudioProcessor(opts);
  return instance;
}

export function getAudioProcessor(): AudioProcessor {
  if (!instance) throw new Error('AudioProcessor not initialized');
  return instance;
}
