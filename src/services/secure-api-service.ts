// src/services/secure-api-service.ts
import { safeStorage, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { log } from '../core/logger';
import { getAppState } from './app-state';

export interface ApiRequestInit extends RequestInit {
  /** Skip auth header (for login/refresh endpoints) */
  skipAuth?: boolean;
  /** Timeout in ms (default 30s) */
  timeoutMs?: number;
  /** Retry on 5xx / network error (default 2) */
  retries?: number;
}

export class SecureApiService {
  private tokensFile = '';
  private tokens: { access: string | null; refresh: string | null; expiresAt: number | null } = {
    access: null,
    refresh: null,
    expiresAt: null,
  };

  init(): void {
    const dir = app.getPath('userData');
    this.tokensFile = path.join(dir, 'jarvis-tokens.bin');
    this.loadTokens();
    log.services.info('secure-api-service ready');
  }

  /* ---- Token storage ---------------------------------------------------- */

  private loadTokens(): void {
    try {
      if (!fs.existsSync(this.tokensFile)) return;
      const buf = fs.readFileSync(this.tokensFile);
      const decrypted = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : buf.toString('utf8');
      const parsed = JSON.parse(decrypted);
      this.tokens = {
        access: parsed.access ?? null,
        refresh: parsed.refresh ?? null,
        expiresAt: parsed.expiresAt ?? null,
      };
      // Hydrate AppState too
      getAppState().setAuth({
        token: this.tokens.access,
        refreshToken: this.tokens.refresh,
        expiresAt: this.tokens.expiresAt,
        user: parsed.user ?? null,
      });
      log.services.debug('tokens loaded');
    } catch (err) {
      log.services.error('failed to load tokens', err);
    }
  }

  private saveTokens(): void {
    try {
      const payload = JSON.stringify({
        access: this.tokens.access,
        refresh: this.tokens.refresh,
        expiresAt: this.tokens.expiresAt,
        user: getAppState().getAuth().user,
      });
      const buf = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(payload)
        : Buffer.from(payload, 'utf8');
      fs.writeFileSync(this.tokensFile, buf, { mode: 0o600 });
    } catch (err) {
      log.services.error('failed to save tokens', err);
    }
  }

  setTokens(access: string | null, refresh: string | null, expiresAt: number | null): void {
    this.tokens = { access, refresh, expiresAt };
    this.saveTokens();
    getAppState().setAuth({
      token: access,
      refreshToken: refresh,
      expiresAt,
      user: getAppState().getAuth().user,
    });
  }

  clearTokens(): void {
    this.tokens = { access: null, refresh: null, expiresAt: null };
    try {
      if (fs.existsSync(this.tokensFile)) fs.unlinkSync(this.tokensFile);
    } catch (err) {
      log.services.error('failed to delete tokens file', err);
    }
    getAppState().clearAuth();
  }

  getAccessToken(): string | null {
    return this.tokens.access;
  }

  isAuthenticated(): boolean {
    return this.tokens.access !== null && (this.tokens.expiresAt === null || this.tokens.expiresAt > Date.now());
  }

  /* ---- HTTP ------------------------------------------------------------- */

  async request<T = unknown>(url: string, init: ApiRequestInit = {}): Promise<T> {
    const { skipAuth, timeoutMs = 30_000, retries = 2, ...rest } = init;

    const headers = new Headers(rest.headers);
    headers.set('Accept', 'application/json');
    if (rest.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (!skipAuth && this.tokens.access) {
      headers.set('Authorization', `Bearer ${this.tokens.access}`);
    }

    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt <= retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          ...rest,
          headers,
          signal: controller.signal,
        });

        if (res.status === 401 && !skipAuth) {
          // Attempt refresh once
          clearTimeout(timer);
          const refreshed = await this.tryRefresh(url);
          if (refreshed) {
            attempt++;
            continue;
          }
          throw new ApiError(401, 'Unauthorized');
        }

        if (!res.ok) {
          const body = await safeReadBody(res);
          const retryable = res.status >= 500 || res.status === 429;
          if (retryable && attempt < retries) {
            attempt++;
            await sleep(200 * 2 ** attempt);
            continue;
          }
          throw new ApiError(res.status, `HTTP ${res.status}`, body);
        }

        clearTimeout(timer);
        return (await safeReadBody(res)) as T;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;

        const isNetwork = err instanceof TypeError || (err as { name?: string }).name === 'AbortError';
        if (isNetwork && attempt < retries) {
          attempt++;
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }

    throw lastErr ?? new Error('request failed');
  }

  private async tryRefresh(originalUrl: string): Promise<boolean> {
    if (!this.tokens.refresh) return false;
    try {
      const origin = new URL(originalUrl).origin;
      const res = await fetch(`${origin}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: this.tokens.refresh }),
      });
      if (!res.ok) {
        this.clearTokens();
        return false;
      }
      const data = (await res.json()) as {
        access: string;
        refresh?: string;
        expiresAt?: number;
      };
      this.setTokens(data.access, data.refresh ?? this.tokens.refresh, data.expiresAt ?? null);
      log.services.info('token refreshed');
      return true;
    } catch (err) {
      log.services.error('token refresh failed', err);
      return false;
    }
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function safeReadBody(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) return await res.json();
    return await res.text();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let instance: SecureApiService | null = null;
export function initSecureApiService(): SecureApiService {
  if (instance) return instance;
  instance = new SecureApiService();
  return instance;
}
export function getSecureApiService(): SecureApiService {
  if (!instance) throw new Error('SecureApiService not initialized');
  return instance;
}
