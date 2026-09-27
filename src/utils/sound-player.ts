// src/utils/sound-player.ts
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { log } from '../core/logger';
import { getAppSettingsService } from '../services/app-settings-service';
import { getMachineInfo } from '../core/machine-arch';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type SoundName =
  | 'confetti-pop'
  | 'recording-start'
  | 'recording-stop'
  | 'error'
  | 'notification';

export interface SoundPlayerEvents {
  'play:start': { name: SoundName; file: string };
  'play:end': { name: SoundName; durationMs: number };
  'play:error': { name: SoundName; error: string };
  'muted': void;
}

export interface SoundPlayerOptions {
  /** Base directory holding .mp3/.wav files. Defaults to resources/sounds. */
  soundDir?: string;
  /** Default volume 0..1. Default 0.7. */
  volume?: number;
  /** Max concurrent sounds. Default 3. */
  maxConcurrent?: number;
}

const DEFAULTS: Required<SoundPlayerOptions> = {
  soundDir: '',
  volume: 0.7,
  maxConcurrent: 3,
};

/* -------------------------------------------------------------------------- */
/* Sound registry                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Map logical names to files. If a file is missing at runtime, the player
 * logs a warning and silently no-ops — sounds are never load-bearing.
 */
const SOUND_FILES: Record<SoundName, string> = {
  'confetti-pop': 'confetti-pop.mp3',
  'recording-start': 'recording-start.mp3',
  'recording-stop': 'recording-stop.mp3',
  error: 'error.mp3',
  notification: 'notification.mp3',
};

/* -------------------------------------------------------------------------- */
/* Player                                                                     */
/* -------------------------------------------------------------------------- */

export class SoundPlayer extends EventEmitter {
  private opts: Required<SoundPlayerOptions>;
  private active = new Set<ChildProcess>();
  private resolvedDir = '';
  private muted = false;

  constructor(opts: SoundPlayerOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
  }

  /* ---- Lifecycle -------------------------------------------------------- */

  init(): void {
    this.resolvedDir = this.opts.soundDir || defaultSoundDir();

    if (!fs.existsSync(this.resolvedDir)) {
      log.audio.warn(`sound dir not found: ${this.resolvedDir}`);
    }

    // Respect the user's setting
    try {
      this.muted = !getAppSettingsService().get().soundsEnabled;
    } catch {
      this.muted = false;
    }

    // React to settings changes
    try {
      const svc = getAppSettingsService();
      svc.on('applied', (patch: { soundsEnabled?: boolean }) => {
        if (patch.soundsEnabled !== undefined) {
          this.setMuted(!patch.soundsEnabled);
        }
      });
    } catch {
      /* settings not ready yet — safe to ignore */
    }

    log.audio.info(`sound-player ready (dir=${this.resolvedDir}, muted=${this.muted})`);
  }

  /* ---- Public API ------------------------------------------------------- */

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.stopAll();
      this.emit('muted');
    }
    log.audio.debug(`sound-player ${muted ? 'muted' : 'unmuted'}`);
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Fire-and-forget playback. Never throws.
   * @param name     Logical sound name
   * @param options  Optional override for volume
   */
  play(name: SoundName, options: { volume?: number } = {}): void {
    try {
      if (this.muted) return;

      const file = this.resolveFile(name);
      if (!file) return;

      if (this.active.size >= this.opts.maxConcurrent) {
        log.audio.debug(`sound skipped (concurrency limit): ${name}`);
        return;
      }

      const volume = clamp(options.volume ?? this.opts.volume, 0, 1);
      const started = Date.now();
      this.emit('play:start', { name, file });

      const child = this.spawnPlayer(file, volume);
      if (!child) return;

      this.active.add(child);

      child.on('error', (err) => {
        this.active.delete(child);
        log.audio.warn(`sound player error for ${name}`, err);
        this.emit('play:error', { name, error: err.message });
      });

      child.on('exit', (code) => {
        this.active.delete(child);
        const durationMs = Date.now() - started;
        if (code !== 0 && code !== null) {
          // Non-zero exit is common on some platforms; log at debug only
          log.audio.debug(`sound ${name} exited with code ${code}`);
        }
        this.emit('play:end', { name, durationMs });
      });
    } catch (err) {
      // Sounds must never break the app
      log.audio.debug(`sound play failed silently: ${name}`, err);
    }
  }

  /** Stop all currently-playing sounds. */
  stopAll(): void {
    for (const child of this.active) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }

  /** Preload check — returns true if the file exists and is playable. */
  isAvailable(name: SoundName): boolean {
    return this.resolveFile(name) !== null;
  }

  /* ---- Internals -------------------------------------------------------- */

  private resolveFile(name: SoundName): string | null {
    const filename = SOUND_FILES[name];
    if (!filename) return null;

    const candidate = path.join(this.resolvedDir, filename);
    if (!fs.existsSync(candidate)) {
      log.audio.debug(`sound file missing: ${candidate}`);
      return null;
    }
    return candidate;
  }

  /**
   * Spawn the OS-native audio player for this file.
   * Returns null if no suitable player is found.
   */
  private spawnPlayer(file: string, volume: number): ChildProcess | null {
    const platform = getMachineInfo().platform;

    if (platform === 'darwin') {
      // afplay is always present on macOS
      // Volume is 0..255 for afplay; -v flag
      const vol = Math.round(volume * 255);
      return spawn('afplay', ['-v', String(vol), file], { stdio: 'ignore' });
    }

    if (platform === 'win32') {
      return spawnWindowsPlayer(file, volume);
    }

    // Linux: try common players in order
    const linuxPlayers: Array<[string, string[]]> = [
      ['paplay', [file]],
      ['aplay', ['-q', file]],
      ['mpg123', ['-q', file]],
      ['mpg321', ['-q', file]],
      ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume * 100)), file]],
    ];

    for (const [bin, args] of linuxPlayers) {
      if (whichSync(bin)) {
        return spawn(bin, args, { stdio: 'ignore' });
      }
    }

    log.audio.warn('no audio player found on Linux — tried paplay, aplay, mpg123, mpg321, ffplay');
    return null;
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof SoundPlayerEvents>(event: K, payload: SoundPlayerEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof SoundPlayerEvents>(
    event: K,
    listener: (payload: SoundPlayerEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

/* -------------------------------------------------------------------------- */
/* Platform helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Windows playback via PowerShell's Media.SoundPlayer.
 * Only supports WAV natively. For MP3 we fall back to ffplay (bundled).
 */
function spawnWindowsPlayer(file: string, volume: number): ChildProcess | null {
  const ext = path.extname(file).toLowerCase();

  if (ext === '.wav') {
    // PowerShell one-liner; escapes single quotes in the path
    const safe = file.replace(/'/g, "''");
    const ps = `(New-Object Media.SoundPlayer '${safe}').PlaySync();`;
    return spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', windowsHide: true }
    );
  }

  // MP3 or other — use our bundled ffplay if available
  const ffplay = resolveBundledFfplay();
  if (ffplay) {
    return spawn(
      ffplay,
      ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume * 100)), file],
      { stdio: 'ignore', windowsHide: true }
    );
  }

  log.audio.warn(`no Windows player for ${ext} — bundle ffplay or use WAV sounds`);
  return null;
}

/** Locate ffplay in our packaged resources or repo assets. */
function resolveBundledFfplay(): string | null {
  const machine = getMachineInfo();
  const exe = machine.platform === 'win32' ? 'ffplay.exe' : 'ffplay';

  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'ffmpeg', exe)]
    : [
        path.join(__dirname, '..', '..', 'assets', 'ffmpeg', machine.ffmpegFolder, exe),
        path.join(app.getAppPath(), 'assets', 'ffmpeg', machine.ffmpegFolder, exe),
      ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Default location of the sounds directory, packaged or in dev. */
function defaultSoundDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sounds');
  }
  // Dev: repo/assets/sounds
  const repoRoot = app.getAppPath();
  return path.join(repoRoot, 'assets', 'sounds');
}

/** Synchronous `which` — returns true if the binary is on PATH. */
function whichSync(bin: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(checker, [bin], { stdio: 'ignore', timeout: 500 });
    return true;
  } catch {
    return false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                  */
/* -------------------------------------------------------------------------- */

let instance: SoundPlayer | null = null;

export function initSoundPlayer(opts: SoundPlayerOptions = {}): SoundPlayer {
  if (instance) return instance;
  instance = new SoundPlayer(opts);
  instance.init();
  return instance;
}

export function getSoundPlayer(): SoundPlayer {
  if (!instance) throw new Error('SoundPlayer not initialized');
  return instance;
}

/**
 * Safe fire-and-forget helper — silently no-ops if the player isn't ready.
 * Use this in code paths that might run before app.whenReady().
 */
export function playSound(name: SoundName, options?: { volume?: number }): void {
  try {
    getSoundPlayer().play(name, options);
  } catch {
    /* silent */
  }
}
