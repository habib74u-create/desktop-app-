// src/transcription/sherpa-onnx-transcriber.ts
import fs from 'fs';
import path from 'path';
import { log } from '../core/logger';
import { getSherpaModelManager } from './sherpa-models';
import type { TranscriptionEngine, TranscriptionResult } from '../services/transcription-service';

/**
 * Offline sherpa-onnx recognizer.
 * Uses `sherpa-onnx-node` — prebuilt binaries for all platforms [citation:5].
 */
export class SherpaOnnxTranscriber implements TranscriptionEngine {
  readonly name = 'sherpa-local' as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognizer: any = null;
  private modelId: string;
  private sampleRate = 16000;

  constructor(modelId = 'whisper-tiny-en') {
    this.modelId = modelId;
  }

  async init(): Promise<void> {
    const mgr = getSherpaModelManager();
    if (!mgr.isInstalled(this.modelId)) {
      log.transcription.info(`downloading sherpa model ${this.modelId}…`);
      await mgr.download(this.modelId);
    }

    const dir = mgr.modelDir(this.modelId);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sherpa = require('sherpa-onnx-node');

    // Offline model config — adjust based on model type (whisper vs transducer)
    const config = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: path.join(dir, 'tiny.en-encoder.onnx'),
          decoder: path.join(dir, 'tiny.en-decoder.onnx'),
        },
        tokens: path.join(dir, 'tiny.en-tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
      },
    };

    this.recognizer = new sherpa.OfflineRecognizer(config);
    log.transcription.info(`sherpa offline loaded: ${this.modelId}`);
  }

  async dispose(): Promise<void> {
    this.recognizer = null;
  }

  async transcribe(input: {
    path?: string;
    pcm?: Float32Array;
    sampleRate?: number;
  }): Promise<TranscriptionResult> {
    if (!this.recognizer) throw new Error('sherpa not initialized');

    const start = Date.now();
    const sampleRate = input.sampleRate ?? this.sampleRate;

    let samples: Float32Array;
    if (input.pcm) {
      samples = input.pcm;
    } else if (input.path) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sherpa = require('sherpa-onnx-node');
      const wave = sherpa.readWave(input.path);
      samples = wave.samples;
    } else {
      throw new Error('transcribe requires path or pcm');
    }

    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    stream.inputFinished();
    this.recognizer.decode(stream);
    const result = this.recognizer.getResult(stream);

    return {
      text: (result?.text ?? '').trim(),
      language: 'auto',
      durationMs: Date.now() - start,
      engine: 'sherpa-local',
    };
  }
}
