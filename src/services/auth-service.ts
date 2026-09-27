// src/services/auth-service.ts
import { EventEmitter } from 'events';
import { shell } from 'electron';
import { log } from '../core/logger';
import { getSecureApiService, ApiError } from './secure-api-service';
import { getAppState } from './app-state';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export interface AuthEvents {
  'signed-in': AuthUser;
  'signed-out': void;
  'session-expired': void;
}

export class AuthService extends EventEmitter {
  private api = getSecureApiService();
  private state = getAppState();

  init(): void {
    // Watch for auth cleared elsewhere
    this.state.on('auth:changed', (auth) => {
      if (!auth.token) this.emit('signed-out');
    });
    log.auth.info('auth-service ready');
  }

  isAuthenticated(): boolean {
    return this.api.isAuthenticated();
  }

  getUser(): AuthUser | null {
    return this.state.getAuth().user;
  }

  /* ---- Login ------------------------------------------------------------ */

  async loginWithEmail(email: string, password: string): Promise<AuthUser> {
    try {
      const res = await this.api.request<{
        access: string;
        refresh: string;
        expiresAt?: number;
        user: AuthUser;
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        skipAuth: true,
      });

      this.api.setTokens(res.access, res.refresh, res.expiresAt ?? null);
      this.state.setAuth({
        token: res.access,
        refreshToken: res.refresh,
        expiresAt: res.expiresAt ?? null,
        user: res.user,
      });

      log.auth.info(`signed in: ${res.user.email}`);
      this.emit('signed-in', res.user);
      return res.user;
    } catch (err) {
      if (err instanceof ApiError) {
        log.auth.warn(`login failed: ${err.status}`, err.body);
      }
      throw err;
    }
  }

  /** Magic-link / OAuth flow: opens browser, awaits callback via deep link. */
  async loginWithBrowser(provider: 'google' | 'github' | 'apple'): Promise<AuthUser> {
    const callbackUrl = `jarvis://auth/callback?provider=${provider}`;
    const authUrl = `https://example.com/auth/${provider}?redirect=${encodeURIComponent(callbackUrl)}`;
    await shell.openExternal(authUrl);
    log.auth.info(`opened browser for ${provider} login`);
    // The actual callback arrives via app.on('open-url') in main.ts —
    // that handler calls `completeBrowserLogin(code)`.
    throw new Error('Browser login pending — callback must call completeBrowserLogin()');
  }

  async completeBrowserLogin(code: string): Promise<AuthUser> {
    const res = await this.api.request<{
      access: string;
      refresh: string;
      expiresAt?: number;
      user: AuthUser;
    }>('/auth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
      skipAuth: true,
    });

    this.api.setTokens(res.access, res.refresh, res.expiresAt ?? null);
    this.state.setAuth({
      token: res.access,
      refreshToken: res.refresh,
      expiresAt: res.expiresAt ?? null,
      user: res.user,
    });
    this.emit('signed-in', res.user);
    return res.user;
  }

  /* ---- Logout ----------------------------------------------------------- */

  async logout(): Promise<void> {
    try {
      await this.api.request('/auth/logout', { method: 'POST' });
    } catch (err) {
      log.auth.warn('logout request failed (continuing)', err);
    } finally {
      this.api.clearTokens();
      this.state.clearAuth();
      log.auth.info('signed out');
      this.emit('signed-out');
    }
  }

  /* ---- Session ---------------------------------------------------------- */

  async refresh(): Promise<boolean> {
    // Delegated to secure-api-service, but exposed for manual triggers
    const ok = this.api.isAuthenticated();
    if (!ok) this.emit('session-expired');
    return ok;
  }

  override emit<K extends keyof AuthEvents>(event: K, payload: AuthEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof AuthEvents>(
    event: K,
    listener: (payload: AuthEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

let instance: AuthService | null = null;
export function initAuthService(): AuthService {
  if (instance) return instance;
  instance = new AuthService();
  return instance;
}
export function getAuthService(): AuthService {
  if (!instance) throw new Error('AuthService not initialized');
  return instance;
}
