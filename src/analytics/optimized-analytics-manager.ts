// src/analytics/optimized-analytics-manager.ts
import { EventEmitter } from 'events';
import { app } from 'electron';
import { log } from '../core/logger';
import { getPrivacyConsentService } from '../services/privacy-consent-service';
import {
  captureBatch,
  buildIdentifyEvent,
  buildScreenEvent,
  getDistinctId,
  isEnabled,
  resetDistinctId,
  setDistinctId,
  type PostHogEvent,
} from './posthog';

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

export interface AnalyticsConfig {
  /** Max events per batch */
  maxBatchSize: number;
  /** Flush interval in ms */
  flushIntervalMs: number;
  /** Max events queued before dropping oldest */
  maxQueueSize: number;
  /** Max retries per batch */
  maxRetries: number;
  /** Base backoff delay in ms (doubles each retry) */
  baseBackoffMs: number;
  /** Dedup window in ms — identical events within this window are dropped */
  dedupeWindowMs: number;
  /** Respect consent changes — flush or drop immediately */
  honorConsentChanges: boolean;
}

const DEFAULT_CONFIG: AnalyticsConfig = {
  maxBatchSize: 50,
  flushIntervalMs: 5000,
  maxQueueSize: 1000,
  maxRetries: 3,
  baseBackoffMs: 1000,
  dedupeWindowMs: 250,
  honorConsentChanges: true,
};

/* -------------------------------------------------------------------------- */
/* Manager                                                                    */
/* -------------------------------------------------------------------------- */

export interface AnalyticsEvents {
  'queue:size': { size: number };
  'batch:sent': { count: number; durationMs: number };
  'batch:failed': { count: number; error: string; willRetry: boolean };
  'consent:revoked': void;
  'consent:granted': void;
}

export class OptimizedAnalyticsManager extends EventEmitter {
  private config: AnalyticsConfig;
  private queue: PostHogEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private recentEvents = new Map<string, number>(); // hash → ts
  private started = false;
  private lastConsentState: boolean;

  constructor(config: Partial<AnalyticsConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastConsentState = this.checkConsent();
  }

  /* ---- Lifecycle -------------------------------------------------------- */

  start(): void {
    if (this.started) return;
    this.started = true;

    // Watch consent changes
    if (this.config.honorConsentChanges) {
      try {
        getPrivacyConsentService().on('analytics:changed', (enabled: boolean) => {
          this.onConsentChanged(enabled);
        });
      } catch {
        log.analytics.warn('consent service not ready — consent gating deferred');
      }
    }

    // Flush on app quit
    app.on('before-quit', () => {
      void this.shutdown();
    });

    // Periodic flush
    this.scheduleFlush();

    log.analytics.info(
      `analytics manager started (enabled=${isEnabled()} interval=${this.config.flushIntervalMs}ms batch=${this.config.maxBatchSize})`
    );
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Final best-effort flush with a hard timeout
    try {
      await Promise.race([this.flush(true), sleep(2500)]);
    } catch {
      /* ignore */
    }
    this.queue = [];
    this.started = false;
    log.analytics.info('analytics manager stopped');
  }

  /* ---- Public API ------------------------------------------------------- */

  /** Track an event. Safe to call from anywhere — never throws. */
  capture(event: string, properties: Record<string, unknown> = {}): void {
    try {
      if (!isEnabled()) return;
      if (!event || typeof event !== 'string') return;

      // Dedup rapid-fire identical events
      const key = this.hashEvent(event, properties);
      const now = Date.now();
      const last = this.recentEvents.get(key);
      if (last !== undefined && now - last < this.config.dedupeWindowMs) {
        return;
      }
      this.recentEvents.set(key, now);
      this.pruneRecentEvents(now);

      const record: PostHogEvent = {
        event,
        distinct_id: getDistinctId(),
        properties,
        timestamp: new Date().toISOString(),
      };

      this.enqueue(record);
    } catch (err) {
      // Analytics must never break the app
      log.analytics.debug('capture failed silently', err);
    }
  }

  /** Track a screen view. */
  screen(name: string, properties: Record<string, unknown> = {}): void {
    try {
      if (!isEnabled()) return;
      this.enqueue(buildScreenEvent(name, properties));
    } catch (err) {
      log.analytics.debug('screen failed silently', err);
    }
  }

  /** Identify the current user. */
  identify(userId: string, traits: Record<string, unknown> = {}): void {
    try {
      if (!isEnabled()) return;
      setDistinctId(`user_${userId}`);
      this.enqueue(buildIdentifyEvent(`user_${userId}`, traits));
    } catch (err) {
      log.analytics.debug('identify failed silently', err);
    }
  }

  /** Reset identity (logout / consent revoke). */
  reset(): void {
    this.queue = [];
    this.recentEvents.clear();
    resetDistinctId();
    log.analytics.info('analytics identity reset');
  }

  /** Force a flush (e.g. before showing an important screen). */
  async flushNow(): Promise<void> {
    await this.flush(true);
  }

  /* ---- Internals -------------------------------------------------------- */

  private enqueue(record: PostHogEvent): void {
    if (this.queue.length >= this.config.maxQueueSize) {
      // Drop oldest to protect memory
      const dropped = this.queue.splice(0, this.queue.length - this.config.maxQueueSize + 1);
      log.analytics.warn(`analytics queue overflow — dropped ${dropped.length} events`);
    }
    this.queue.push(record);
    this.emit('queue:size', { size: this.queue.length });

    if (this.queue.length >= this.config.maxBatchSize) {
      void this.flush(false);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flush(false).finally(() => {
        if (this.started) this.scheduleFlush();
      });
    }, this.config.flushIntervalMs);
  }

  /**
   * Drain the queue to PostHog.
   * @param force — flush even if below batch threshold (used on shutdown)
   */
  private async flush(force: boolean): Promise<void> {
    if (this.inFlight) return;
    if (this.queue.length === 0) return;
    if (!force && this.queue.length < this.config.maxBatchSize / 2) return;
    if (!isEnabled()) {
      this.queue = [];
      return;
    }

    this.inFlight = true;
    const start = Date.now();
    const batch = this.queue.splice(0, this.config.maxBatchSize);

    try {
      await this.sendWithRetry(batch);
      this.emit('batch:sent', { count: batch.length, durationMs: Date.now() - start });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('batch:failed', { count: batch.length, error: msg, willRetry: false });
      log.analytics.warn(`dropped ${batch.length} events after retries: ${msg}`);
    } finally {
      this.inFlight = false;
      if (this.queue.length > 0 && this.started) {
        // Drain remaining
        void this.flush(false);
      }
    }
  }

  private async sendWithRetry(batch: PostHogEvent[]): Promise<void> {
    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt <= this.config.maxRetries) {
      try {
        await captureBatch(batch);
        return;
      } catch (err) {
        lastErr = err;
        attempt++;
        if (attempt > this.config.maxRetries) break;
        const backoff = this.config.baseBackoffMs * 2 ** (attempt - 1);
        log.analytics.debug(`retry ${attempt}/${this.config.maxRetries} in ${backoff}ms`);
        await sleep(backoff);
      }
    }
    throw lastErr ?? new Error('unknown error');
  }

  private onConsentChanged(enabled: boolean): void {
    if (enabled === this.lastConsentState) return;
    this.lastConsentState = enabled;

    if (enabled) {
      log.analytics.info('analytics consent granted');
      this.emit('consent:granted');
      // Do not retroactively send events queued while disabled
    } else {
      log.analytics.info('analytics consent revoked — dropping queue');
      this.queue = [];
      this.recentEvents.clear();
      resetDistinctId();
      this.emit('consent:revoked');
    }
  }

  private checkConsent(): boolean {
    try {
      return getPrivacyConsentService().hasAnalyticsConsent();
    } catch {
      return false;
    }
  }

  private hashEvent(event: string, props: Record<string, unknown>): string {
    // Cheap stable hash of event + shallow properties
    const keys = Object.keys(props).sort();
    const parts = [event];
    for (const k of keys) {
      const v = props[k];
      if (v === undefined || typeof v === 'function') continue;
      parts.push(`${k}=${typeof v === 'object' ? '[obj]' : String(v)}`);
    }
    return parts.join('|');
  }

  private pruneRecentEvents(now: number): void {
    if (this.recentEvents.size < 500) return;
    const cutoff = now - this.config.dedupeWindowMs * 4;
    for (const [k, ts] of this.recentEvents) {
      if (ts < cutoff) this.recentEvents.delete(k);
    }
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof AnalyticsEvents>(event: K, payload: AnalyticsEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof AnalyticsEvents>(
    event: K,
    listener: (payload: AnalyticsEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                  */
/* -------------------------------------------------------------------------- */

let instance: OptimizedAnalyticsManager | null = null;

export function initAnalytics(config: Partial<AnalyticsConfig> = {}): OptimizedAnalyticsManager {
  if (instance) return instance;
  instance = new OptimizedAnalyticsManager(config);
  instance.start();
  return instance;
}

export function getAnalytics(): OptimizedAnalyticsManager {
  if (!instance) throw new Error('Analytics not initialized — call initAnalytics() first');
  return instance;
}

/**
 * Safe no-op tracker if analytics isn't initialized yet.
 * Use this in code paths that might run before app.whenReady().
 */
export function track(event: string, properties: Record<string, unknown> = {}): void {
  try {
    getAnalytics().capture(event, properties);
  } catch {
    /* silent */
  }
}
