// src/core/machine-arch.ts
import os from 'os';
import { app } from 'electron';

export type Platform = 'darwin' | 'win32' | 'linux';
export type CpuArch = 'x64' | 'arm64' | 'ia32' | 'arm';

export interface MachineInfo {
  platform: Platform;
  arch: CpuArch;
  /** Folder name inside assets/ffmpeg/ */
  ffmpegFolder: 'mac' | 'win' | 'linux';
  /** Executable name without path */
  ffmpegBinary: string;
  ffprobeBinary: string;
  /** True on Apple Silicon Macs */
  isAppleSilicon: boolean;
  /** True if running under Rosetta 2 */
  isRosetta: boolean;
  /** Total RAM in bytes */
  totalMemory: number;
  /** Logical CPU count */
  cpuCount: number;
  /** Electron / Chromium / Node versions */
  versions: {
    electron: string;
    chrome: string;
    node: string;
    v8: string;
    app: string;
  };
  /** Whether this is a packaged production build */
  isPackaged: boolean;
  /** OS release string */
  osRelease: string;
}

function normalizeArch(a: string): CpuArch {
  if (a === 'x64' || a === 'amd64') return 'x64';
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  if (a === 'ia32' || a === 'x86') return 'ia32';
  if (a === 'arm' || a === 'armv7l') return 'arm';
  return 'x64';
}

let cached: MachineInfo | null = null;

export function getMachineInfo(): MachineInfo {
  if (cached) return cached;

  const platform = process.platform as Platform;
  const arch = normalizeArch(process.arch);

  const ffmpegFolder: MachineInfo['ffmpegFolder'] =
    platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';

  const exeSuffix = platform === 'win32' ? '.exe' : '';

  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';

  cached = {
    platform,
    arch,
    ffmpegFolder,
    ffmpegBinary: `ffmpeg${exeSuffix}`,
    ffprobeBinary: `ffprobe${exeSuffix}`,
    isAppleSilicon,
    isRosetta: detectRosetta(),
    totalMemory: os.totalmem(),
    cpuCount: os.cpus().length,
    versions: {
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      v8: process.versions.v8 ?? 'unknown',
      app: safeAppVersion(),
    },
    isPackaged: safeIsPackaged(),
    osRelease: os.release(),
  };

  return cached;
}

/** Clear the cache (mostly for tests). */
export function resetMachineInfoCache(): void {
  cached = null;
}

/** Convenience predicates. */
export function isMac(): boolean {
  return getMachineInfo().platform === 'darwin';
}
export function isWindows(): boolean {
  return getMachineInfo().platform === 'win32';
}
export function isLinux(): boolean {
  return getMachineInfo().platform === 'linux';
}
export function isArm(): boolean {
  const { arch } = getMachineInfo();
  return arch === 'arm64' || arch === 'arm';
}
export function isX64(): boolean {
  return getMachineInfo().arch === 'x64';
}

/** Returns the exact ffmpeg binary name for this machine. */
export function ffmpegName(): string {
  return getMachineInfo().ffmpegBinary;
}
export function ffprobeName(): string {
  return getMachineInfo().ffprobeBinary;
}

/** How much RAM in GB (rounded to 1 decimal). */
export function totalMemoryGB(): number {
  return Math.round((getMachineInfo().totalMemory / 1024 ** 3) * 10) / 10;
}

/** Recommended Whisper model based on available RAM. */
export function recommendedWhisperModel(): 'tiny' | 'base' | 'small' | 'medium' | 'large' {
  const gb = totalMemoryGB();
  if (gb < 4) return 'tiny';
  if (gb < 8) return 'base';
  if (gb < 16) return 'small';
  if (gb < 32) return 'medium';
  return 'large';
}

/** Human-friendly summary for logs / About dialog. */
export function machineSummary(): string {
  const m = getMachineInfo();
  const rosetta = m.isRosetta ? ' (Rosetta 2)' : '';
  return [
    `${m.platform}-${m.arch}${rosetta}`,
    `CPU×${m.cpuCount}`,
    `RAM ${totalMemoryGB()}GB`,
    `Electron ${m.versions.electron}`,
    `Node ${m.versions.node}`,
    m.isPackaged ? 'packaged' : 'dev',
  ].join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function detectRosetta(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.arch !== 'x64') return false;
  // On Apple Silicon under Rosetta, sysctl reports the translation
  try {
    // Lazy require so this doesn't break in non-Node envs
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const out = execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], {
      encoding: 'utf8',
      timeout: 500,
    }).trim();
    return out === '1';
  } catch {
    return false;
  }
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

function safeIsPackaged(): boolean {
  try {
    return app.isPackaged;
  } catch {
    return false;
  }
}