// src/core/logger.ts
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m',  // cyan
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
};

const RESET = '\x1b[0m';

interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  meta?: unknown;
}

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to LOG_LEVEL env or 'info'. */
  level?: LogLevel;
  /** Directory to write log files. Defaults to app.getPath('logs'). */
  logDir?: string;
  /** Max size per log file before rotation. Default 5 MB. */
  maxFileSize?: number;
  /** How many rotated files to keep. Default 5. */
  maxFiles?: number;
  /** Write to file. Defaults true in prod, false in dev. */
  file?: boolean;
  /** Write to stdout. Defaults true. */
  console?: boolean;
}

class Logger {
  private level: number;
  private logDir: string;
  private maxFileSize: number;
  private maxFiles: number;
  private toFile: boolean;
  private toConsole: boolean;

  private stream: fs.WriteStream | null = null;
  private currentSize = 0;
  private currentFile = '';
  private initialized = false;

  // Subscribers (renderer bridge)
  private subscribers = new Set<(r: LogRecord) => void>();

  constructor(opts: LoggerOptions = {}) {
    const envLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
    this.level = LEVELS[opts.level ?? envLevel] ?? LEVELS.info;

    // app.getPath throws before app is ready — guard it
    let defaultDir = '';
    try {
      defaultDir = app.getPath('logs');
    } catch {
      defaultDir = path.join(os.tmpdir(), 'jarvis-logs');
    }

    this.logDir = opts.logDir ?? defaultDir;
    this.maxFileSize = opts.maxFileSize ?? 5 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;
    this.toConsole = opts.console ?? true;
    this.toFile = opts.file ?? app.isPackaged;
  }

  /** Call once after app.whenReady() to open the log file. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.toFile) return;

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.openStream();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[logger] failed to init file logging:', err);
      this.toFile = false;
    }
  }

  private openStream(): void {
    const date = new Date().toISOString().slice(0, 10);
    this.currentFile = path.join(this.logDir, `jarvis-${date}.log`);

    // Append if exists; measure size for rotation
    if (fs.existsSync(this.currentFile)) {
      this.currentSize = fs.statSync(this.currentFile).size;
    } else {
      this.currentSize = 0;
    }

    this.stream = fs.createWriteStream(this.currentFile, { flags: 'a' });
    this.stream.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[logger] stream error:', err);
    });
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (!this.toFile) return;
    if (this.currentSize + nextBytes <= this.maxFileSize) {
      this.currentSize += nextBytes;
      return;
    }

    // Close current
    this.stream?.end();
    this.stream = null;

    // Rotate: jarvis-YYYY-MM-DD.log → .1, .1 → .2, ...
    const base = this.currentFile;
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? base : `${base}.${i - 1}`;
      const to = `${base}.${i}`;
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }

    this.openStream();
  }

  private write(level: LogLevel, scope: string, msg: string, meta?: unknown): void {
    if (LEVELS[level] < this.level) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      meta,
    };

    const line = this.format(record);

    if (this.toConsole) {
      const color = COLORS[level];
      // eslint-disable-next-line no-console
      console.log(`${color}${line}${RESET}`);
    }

    if (this.toFile) {
      const bytes = Buffer.byteLength(line + '\n');
      this.rotateIfNeeded(bytes);
      this.stream?.write(line + '\n');
    }

    // Notify subscribers (renderer)
    for (const sub of this.subscribers) {
      try {
        sub(record);
      } catch {
        /* ignore */
      }
    }
  }

  private format(r: LogRecord): string {
    const meta = r.meta !== undefined ? ` ${safeStringify(r.meta)}` : '';
    return `[${r.ts}] [${r.level.toUpperCase().padEnd(5)}] [${r.scope}] ${r.msg}${meta}`;
  }

  /** Create a scoped logger. */
  scope(name: string): ScopedLogger {
    return new ScopedLogger(this, name);
  }

  /** Subscribe to log records (used by IPC bridge). */
  subscribe(fn: (r: LogRecord) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Change the minimum level at runtime. */
  setLevel(level: LogLevel): void {
    this.level = LEVELS[level];
  }

  /** Flush and close the file stream (call on app quit). */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }

  /** Path of the currently active log file (or '' if disabled). */
  getLogFilePath(): string {
    return this.currentFile;
  }

  // Internal — used by ScopedLogger
  _write(level: LogLevel, scope: string, msg: string, meta?: unknown): void {
    this.write(level, scope, msg, meta);
  }
}

export class ScopedLogger {
  constructor(private parent: Logger, private scopeName: string) {}

  debug(msg: string, meta?: unknown): void {
    this.parent._write('debug', this.scopeName, msg, meta);
  }
  info(msg: string, meta?: unknown): void {
    this.parent._write('info', this.scopeName, msg, meta);
  }
  warn(msg: string, meta?: unknown): void {
    this.parent._write('warn', this.scopeName, msg, meta);
  }
  error(msg: string, meta?: unknown): void {
    this.parent._write('error', this.scopeName, msg, meta);
  }
  fatal(msg: string, meta?: unknown): void {
    this.parent._write('fatal', this.scopeName, msg, meta);
  }

  /** Create a nested scope: `log.scope('a').scope('b')` → `[a:b]` */
  scope(name: string): ScopedLogger {
    return new ScopedLogger(this.parent, `${this.scopeName}:${name}`);
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

/** Singleton logger — import this everywhere. */
export const logger = new Logger();

/** Convenience: pre-scoped loggers for common subsystems. */
export const log = {
  main: logger.scope('main'),
  ipc: logger.scope('ipc'),
  audio: logger.scope('audio'),
  input: logger.scope('input'),
  transcription: logger.scope('transcription'),
  services: logger.scope('services'),
  updater: logger.scope('updater'),
  auth: logger.scope('auth'),
  analytics: logger.scope('analytics'),
};

/** Global crash handlers — call once from main.ts. */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    log.main.fatal('uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    log.main.fatal('unhandledRejection', reason);
  });
}
