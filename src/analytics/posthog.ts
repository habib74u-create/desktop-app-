// src/analytics/posthog.ts
import { app } from 'electron';
import os from 'os';
import { log } from '../core/logger';
import { getMachineInfo } from '../core/machine-arch';
import { getPrivacyConsentService } from '../services/privacy-consent-service';
import { getAppState } from '../services/app-state';

/**
 * Minimal PostHog HTTP client.
 *
 * We deliberately avoid the official `posthog-node` SDK here because:
 *  1. It pulls in ~4 MB of transitive deps for a capture-only use case.
 *  2. We want full control over batching, retry, and consent gating.
 *  3. It calls `fetch` at module load — bad for Electron cold start.
 *
 * The manager (`optimized-analytics-manager.ts`) calls `posthog.captureBatch()`.
 */

export interface PostHogEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp?: string;
}

export interface PostHogConfig {
  apiKey: string;
  /** e.g. 'https://us.i.posthog.com' or 'https://eu.i.posthog.com' */
  host: string;
  /** Disable entirely (dev, no key, user opted out) */
  disabled?: boolean;
}

const DEFAULT_HOST = 'https://us.i.posthog.com';
const FLUSH_TIMEOUT_MS = 10_000;
const MAX_BATCH = 100;

let config: PostHogConfig = {
  apiKey: process.env.POSTHOG_API_KEY ?? '',
  host: process.env.POSTHOG_HOST ?? DEFAULT_HOST,
  disabled: !process.env.POSTHOG_API_KEY,
};

let distinctId: string | null = null;
let sessionId: string | null = null;
let sessionStartedAt = 0;

export function configurePostHog(patch: Partial<PostHogConfig>): void {
  config = { ...config, ...patch };
  if (!config.apiKey) config.disabled = true;
  log.analytics.debug(`posthog configured (disabled=${config.disabled})`);
}

export function isEnabled(): boolean {
  if (config.disabled) return false;
  if (!config.apiKey) return false;
  // Consent gate — never send without explicit consent
  try {
    if (!getPrivacyConsentService().hasAnalyticsConsent()) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Stable anonymous ID. Generated once and persisted via AppState auth slot.
 * Rotates only when the user resets analytics consent.
 */
export function getDistinctId(): string {
  if (distinctId) return distinctId;

  const state = getAppState();
  const auth = state.getAuth();
  // If signed in, use the user id; otherwise a persistent anonymous id
  if (auth.user?.id) {
    distinctId = `user_${auth.user.id}`;
  } else {
    distinctId = getOrCreateAnonymousId();
  }
  return distinctId;
}

export function setDistinctId(id: string): void {
  distinctId = id;
}

export function resetDistinctId(): void {
  distinctId = null;
  sessionId = null;
}

export function getSessionId(): string {
  if (!sessionId) {
    sessionStartedAt = Date.now();
    sessionId = `${sessionStartedAt}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return sessionId;
}

export function getSessionStartedAt(): number {
  return sessionStartedAt;
}

/* -------------------------------------------------------------------------- */
/* Common properties injected into every event                                */
/* -------------------------------------------------------------------------- */

export function commonProperties(): Record<string, unknown> {
  const machine = getMachineInfo();
  return {
    $app_version: machine.versions.app,
    $os: machine.platform,
    $os_version: machine.osRelease,
    $arch: machine.arch,
    electron_version: machine.versions.electron,
    chrome_version: machine.versions.chrome,
    node_version: machine.versions.node,
    is_packaged: machine.isPackaged,
    cpu_count: machine.cpuCount,
    total_memory_gb: Math.round((machine.totalMemory / 1024 ** 3) * 10) / 10,
    is_apple_silicon: machine.isAppleSilicon,
    is_rosetta: machine.isRosetta,
    $session_id: getSessionId(),
    $lib: 'jarvis-desktop',
    hostname: safeHostname(),
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP capture                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Sends a batch of events. Called only by the optimized manager — do not
 * call directly.
 */
export async function captureBatch(events: PostHogEvent[]): Promise<void> {
  if (!isEnabled() || events.length === 0) return;

  const url = `${config.host.replace(/\/$/, '')}/batch/`;

  const payload = {
    api_key: config.apiKey,
    batch: events.map((e) => ({
      event: e.event,
      distinct_id: e.distinct_id,
      properties: { ...commonProperties(), ...e.properties },
      timestamp: e.timestamp ?? new Date().toISOString(),
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`posthog HTTP ${res.status}`);
    }
    log.analytics.debug(`flushed ${events.length} events`);
  } finally {
    clearTimeout(timer);
  }
}

/** Identify call (fire-and-forget, goes through the same queue). */
export function buildIdentifyEvent(
  userId: string,
  traits: Record<string, unknown>
): PostHogEvent {
  return {
    event: '$identify',
    distinct_id: userId,
    properties: {
      $set: traits,
    },
  };
}

/** Page/screen view — same channel as events. */
export function buildScreenEvent(
  name: string,
  properties: Record<string, unknown> = {}
): PostHogEvent {
  return {
    event: '$screen',
    distinct_id: getDistinctId(),
    properties: {
      $screen_name: name,
      ...properties,
    },
  };
}

export { MAX_BATCH };

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

const ANON_KEY = 'jarvis_anon_id';

function getOrCreateAnonymousId(): string {
  const state = getAppState();
  const auth = state.getAuth();
  // Reuse auth.user slot if we stored the anon id there (we don't today, so
  // fall back to a local file-based approach via AppState's user field)
  if (auth.user?.id?.startsWith('anon_')) return auth.user.id;

  const id = `anon_${randomId()}`;
  state.setAuth({
    token: null,
    refreshToken: null,
    expiresAt: null,
    user: { id, email: 'anonymous@local' },
  });
  log.analytics.info('generated anonymous id');
  return id;
}

function randomId(): string {
  // RFC4122 v4-ish
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function safeHostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}
