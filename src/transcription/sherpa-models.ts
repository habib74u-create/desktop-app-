// src/transcription/sherpa-models.ts
import fs from 'fs';
import path from 'path';
import https from 'https';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';

export interface SherpaModelSpec {
  id: string;
  name: string;
  /** Streaming (online) or offline */
  kind: 'online' | 'offline';
  /** Download URL (.tar.bz2) */
  url: string;
  /** Approximate size for UI */
  sizeMB: number;
  /** Languages supported */
  languages: string[];
  /** Required files after extraction */
  requiredFiles: string[];
}

export const SHERPA_MODELS: SherpaModelSpec[] = [
  {
    id: 'zipformer-en-20m',
    name: 'Zipformer English 20M (streaming)',
    kind: 'online',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2',
    sizeMB: 30,
    languages: ['en'],
    requiredFiles: ['encoder-epoch-99-avg-1.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.onnx', 'tokens.txt'],
  },
  {
    id: 'zipformer-bilingual-zh-en',
    name: 'Zipformer Bilingual ZH-EN (streaming)',
    kind: 'online',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2',
    sizeMB: 130,
    languages: ['zh', 'en'],
    requiredFiles: ['encoder-epoch-99-avg-1.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.onnx', 'tokens.txt'],
  },
  {
    id: 'whisper-tiny-en',
    name: 'Whisper Tiny English (offline)',
    kind: 'offline',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2',
    sizeMB: 75,
    languages: ['en'],
    requiredFiles: ['tiny.en-encoder.onnx', 'tiny.en-decoder.onnx', 'tiny.en-tokens.txt'],
  },
];

export interface SherpaModelEvents {
  'download:progress': { id: string; received: number; total: number };
  'download:complete': { id: string };
  'download:error': { id: string; error: string };
}

export class SherpaModelManager extends EventEmitter {
  private rootDir = '';

  init(): void {
    this.rootDir = path.join(app.getPath('userData'), 'models', 'sherpa');
    fs.mkdirSync(this.rootDir, { recursive: true });
    log.transcription.info(`sherpa models dir: ${this.rootDir}`);
  }

  list(): SherpaModelSpec[] {
    return SHERPA_MODELS;
  }

  isInstalled(id: string): boolean {
    const spec = SHERPA_MODELS.find((m) => m.id === id);
    if (!spec) return false;
    const dir = this.modelDir(id);
    return spec.requiredFiles.every((f) => fs.existsSync(path.join(dir, f)));
  }

  /** Resolve the on-disk directory for a model. */
  modelDir(id: string): string {
    return path.join(this.rootDir, id);
  }

  /** Download + extract. Emits progress events. */
  async download(id: string): Promise<void> {
    const spec = SHERPA_MODELS.find((m) => m.id === id);
    if (!spec) throw new Error(`Unknown sherpa model: ${id}`);
    if (this.isInstalled(id)) {
      this.emit('download:complete', { id });
      return;
    }

    const tmpFile = path.join(this.rootDir, `${id}.tar.bz2`);
    const destDir = this.modelDir(id);

    try {
      fs.mkdirSync(destDir, { recursive: true });
      await this.downloadFile(spec.url, tmpFile, (received, total) => {
        this.emit('download:progress', { id, received, total });
      });

      log.transcription.info(`extracting ${id}…`);
      await this.extractTarBz2(tmpFile, this.rootDir);

      // The archive extracts to a folder; move/rename to modelDir if needed
      const extracted = this.findExtractedDir(spec.url, this.rootDir);
      if (extracted && extracted !== destDir) {
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
        fs.renameSync(extracted, destDir);
      }

      fs.unlinkSync(tmpFile);
      this.emit('download:complete', { id });
      log.transcription.info(`model ready: ${id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('download:error', { id, error: msg });
      log.transcription.error(`download failed: ${id}`, err);
      throw err;
    }
  }

  private downloadFile(url: string, dest: string, onProgress: (r: number, t: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https
        .get(url, (res) => {
          // Follow redirects (GitHub releases do this)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            fs.unlinkSync(dest);
            return this.downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
          }
          if (res.statusCode !== 200) {
            file.close();
            fs.unlinkSync(dest);
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const total = parseInt(res.headers['content-length'] ?? '0', 10);
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            onProgress(received, total);
          });
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', reject);
    });
  }

  /** Uses tar + bzip2 via child_process — available on macOS/Linux. On Windows, use 7zip. */
  private extractTarBz2(archive: string, destDir: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFile } = require('child_process') as typeof import('child_process');
    return new Promise((resolve, reject) => {
      execFile('tar', ['xjf', archive, '-C', destDir], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private findExtractedDir(url: string, root: string): string | null {
    // Extract folder name from URL, e.g. "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17"
    const match = url.match(/([^/]+)\.tar\.bz2$/);
    if (!match) return null;
    const candidate = path.join(root, match[1]);
    return fs.existsSync(candidate) ? candidate : null;
  }

  /* ---- Typed emit/on ---- */

  override emit<K extends keyof SherpaModelEvents>(event: K, payload: SherpaModelEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof SherpaModelEvents>(event: K, listener: (payload: SherpaModelEvents[K]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

let instance: SherpaModelManager | null = null;
export function initSherpaModelManager(): SherpaModelManager {
  if (instance) return instance;
  instance = new SherpaModelManager();
  instance.init();
  return instance;
}
export function getSherpaModelManager(): SherpaModelManager {
  if (!instance) throw new Error('SherpaModelManager not initialized');
  return instance;
}
