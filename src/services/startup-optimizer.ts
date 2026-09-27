// src/services/startup-optimizer.ts
import { app } from 'electron';
import { log } from '../core/logger';

interface Mark {
  name: string;
  t: number;
}

export class StartupOptimizer {
  private startedAt = Date.now();
  private marks: Mark[] = [];
  private deferredTasks: Array<{ name: string; fn: () => Promise<void> | void }> = [];

  mark(name: string): void {
    const t = Date.now();
    this.marks.push({ name, t });
    log.main.debug(`[startup] ${name} @ +${t - this.startedAt}ms`);
  }

  /** Queue work to run after the app is fully idle. */
  defer(name: string, fn: () => Promise<void> | void): void {
    this.deferredTasks.push({ name, fn });
  }

  /** Schedule deferred tasks after a short idle delay. */
  async runDeferred(idleMs = 1500): Promise<void> {
    await new Promise((r) => setTimeout(r, idleMs));

    for (const { name, fn } of this.deferredTasks) {
      try {
        const t0 = Date.now();
        await fn();
        log.main.debug(`[startup] deferred ${name} (${Date.now() - t0}ms)`);
      } catch (err) {
        log.main.error(`[startup] deferred task failed: ${name}`, err);
      }
    }
    this.deferredTasks = [];
    this.report();
  }

  report(): void {
    if (this.marks.length === 0) return;
    const total = Date.now() - this.startedAt;
    log.main.info(`startup complete in ${total}ms`);
    for (let i = 0; i < this.marks.length; i++) {
      const cur = this.marks[i];
      const prev = i > 0 ? this.marks[i - 1].t : this.startedAt;
      log.main.debug(`  ${cur.name}: +${cur.t - prev}ms (total ${cur.t - this.startedAt}ms)`);
    }
  }
}

let instance: StartupOptimizer | null = null;
export function initStartupOptimizer(): StartupOptimizer {
  if (instance) return instance;
  instance = new StartupOptimizer();
  instance.mark('app-ready');
  return instance;
}
export function getStartupOptimizer(): StartupOptimizer {
  if (!instance) throw new Error('StartupOptimizer not initialized');
  return instance;
}
