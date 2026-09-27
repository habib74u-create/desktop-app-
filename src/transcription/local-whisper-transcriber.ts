// src/transcription/local-whisper-transcriber.ts
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { log } from '../core/logger';
import { getMachineInfo, recommendedWhisperModel } from '../core/machine-arch';
import type { TranscriptionEngine, TranscriptionResult } from '../services/transcription-service';

/**
 * whisper.cpp models in ggml format.
 * Sizes from https://huggingface.co/ggerganov/whisper.cpp [citation:12]
 */
export const WHISPER_MODELS = {
  tiny:   { file: 'ggml-tiny.bin',   sizeMB: 75,  memMB: 390 },
  base:   { file: 'ggml-base.bin',   sizeMB: 142, memMB: 500 },
  small:  { file: 'ggml-small.bin',  sizeMB: 466, memMB: 1000 },
  medium: { file: 'ggml-medium.bin', sizeMB: 1500, memMB: 2600 },
  large:  { file: 'ggml-large.bin',  sizeMB: 2900, memMB: 4700 },
} as const;

export type WhisperModelId = keyof typeof WHISPER_MODELS;

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export class LocalWhisperTranscriber implements TranscriptionEngine {
  readonly name = 'whisper-local' as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private whisper: any = null;
  private modelId: WhisperModelId;
  private modelPath = '';
  private modelsDir = '';

  constructor(modelId?: WhisperModelId) {
    this.modelId = modelId ?? (recommendedWhisperModel() as WhisperModelId);
  }

  async init(): Promise<void> {
    const machine = getMachineInfo();
    this.modelsDir = path.join(app.getPath('userData'), 'models', 'whisper');
    fs.mkdirSync(this.modelsDir, { recursive: true });

    this.modelPath = path.join(this.modelsDir, WHISPER_MODELS[this.modelId].file);
    if (!fs.existsSync(this.modelPath)) {
      log.transcription.info(`downloading whisper model ${this.modelId}…`);
      await this.downloadModel(this.modelId, this.modelPath);
    }

    // smart-whisper: GPU auto-enabled on Apple Silicon [citation:2]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Whisper } = require('smart-whisper');
    this.whisper = new Whisper(this.modelPath, {
      gpu: machine.isAppleSilicon,
    });

    log.transcription.info(`whisper loaded: ${this.modelId} (gpu=${machine.isAppleSilicon})`);
  }

  async dispose(): Promise<void> {
    if (this.whisper) {
      try {
        await this.whisper.free();
      } catch (err) {
        log.transcription.warn('whisper free failed', err);
      }
      this.whisper = null;
    }
  }

  async transcribe(input: {
    path?: string;
    pcm?: Float32Array;
    sampleRate?: number;
  }): Promise<TranscriptionResult> {
    if (!this.whisper) throw new Error('whisper not initialized');

    const start = Date.now();

    let pcm: Float32Array;
    if (input.pcm) {
      pcm = input.pcm;
    } else if (input.path) {
      pcm = await this.readWavAsFloat32(input.path);
    } else {
      throw new Error('transcribe requires either path or pcm');
    }

    // smart-whisper returns a task that emits progress
    const task = await this.whisper.transcribe(pcm, {
      language: 'auto',
      // whisper.cpp requires 16kHz mono float32 in [-1, 1]
    });

    const result = await task.result;
    const text = typeof result === 'string' ? result : (result?.text ?? '');

    return {
      text: text.trim(),
      language: result?.language ?? 'auto',
      durationMs: Date.now() - start,
      engine: 'whisper-local',
    };
  }

  /* ---- Helpers ---------------------------------------------------------- */

  private async downloadModel(id: WhisperModelId, dest: string): Promise<void> {
    const url = `${HF_BASE}/${WHISPER_MODELS[id].file}`;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('https') as typeof import('https');

    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const follow = (u: string) => {
        https.get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            return follow(res.headers.location);
          }
          if (res.statusCode !== 200) {
            file.close();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        }).on('error', reject);
      };
      follow(url);
    });
  }

  /** Minimal WAV parser — assumes 16-bit PCM mono @ 16kHz. */
  private async readWavAsFloat32(filePath: string): Promise<Float32Array> {
    const buf = await fs.promises.readFile(filePath);
    // Skip 44-byte WAV header
    const dataOffset = 44;
    const int16 = new Int16Array(buf.buffer, buf.byteOffset + dataOffset, (buf.length - dataOffset) / 2);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      f32[i] = int16[i] / 32768;
    }
    return f32;
  }
}
