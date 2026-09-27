// src/transcription/sherpa-online-transcriber.ts
import path from 'path';
import { log } from '../core/logger';
import { getSherpaModelManager } from './sherpa-models';
import type { TranscriptionResult } from '../services/transcription-service';

/**
 * Streaming (online) sherpa-onnx recognizer.
 * Feed audio in chunks via `acceptChunk()`; get partial results via callback.
 * Model: Zipformer streaming transducer [citation:21][citation:31]
 */
export class SherpaOnlineTranscriber {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognizer: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stream: any = null;
  private sampleRate = 16000;
  private lastText = '';
  private startedAt = 0;
  private modelId: string;

  constructor(modelId = 'zipformer-en-20m') {
    this.modelId = modelId;
  }

  async init(): Promise<void> {
    const mgr = getSherpaModelManager();
    if (!mgr.isInstalled(this.modelId)) {
      log.transcription.info(`downloading sherpa streaming model ${this.modelId}…`);
      await mgr.download(this.modelId);
    }

    const dir = mgr.modelDir(this.modelId);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sherpa = require('sherpa-onnx-node');

    const config = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, 'encoder-epoch-99-avg-1.onnx'),
          decoder: path.join(dir, 'decoder-epoch-99-avg-1.onnx'),
          joiner: path.join(dir, 'joiner-epoch-99-avg-1.onnx'),
        },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        modelType: 'zipformer',
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
    };

    this.recognizer = new sherpa.OnlineRecognizer(config);
    log.transcription.info(`sherpa online loaded: ${this.modelId}`);
  }

  /** Begin a new utterance. */
  start(onPartial: (text: string) => void): { stop: () => Promise<TranscriptionResult> } {
    if (!this.recognizer) throw new Error('sherpa online not initialized');

    this.stream = this.recognizer.createStream();
    this.lastText = '';
    this.startedAt = Date.now();

    return {
      stop: async (): Promise<TranscriptionResult> => {
        // Feed tail padding so the last chunk is processed [citation:21]
        const padding = new Float32Array(Math.floor(this.sampleRate * 0.4));
        this.stream.acceptWaveform({ samples: padding, sampleRate: this.sampleRate });
        this.stream.inputFinished();

        while (this.recognizer.isReady(this.stream)) {
          this.recognizer.decode(this.stream);
        }
        const result = this.recognizer.getResult(this.stream);
        const text = (result?.text ?? '').trim();

        this.stream = null;
        return {
          text,
          language: 'auto',
          durationMs: Date.now() - this.startedAt,
          engine: 'sherpa-local',
        };
      },
    };
  }

  /** Feed a chunk of Float32 PCM (mono, 16kHz). Emits partial results. */
  acceptChunk(samples: Float32Array, onPartial?: (text: string) => void): void {
    if (!this.stream) return;

    this.stream.acceptWaveform({ samples, sampleRate: this.sampleRate });

    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream);
    }

    const text = (this.recognizer.getResult(this.stream).text ?? '').trim();
    if (text && text !== this.lastText) {
      this.lastText = text;
      onPartial?.(text);
    }
  }

  dispose(): void {
    this.stream = null;
    this.recognizer = null;
  }
}
