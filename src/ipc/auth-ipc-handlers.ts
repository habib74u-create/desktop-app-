// src/ipc/auth-ipc-handlers.ts
import { ipcMain } from 'electron';
import { log } from '../core/logger';
import { getAuthService } from '../services/auth-service';
import { CH, wrap } from './ipc-types';
import { emitToAll } from './ipc-handlers';

interface LoginEmailPayload {
  email: string;
  password: string;
}

interface LoginBrowserPayload {
  provider: 'google' | 'github' | 'apple';
}

export function registerAuthIpcHandlers(): void {
  const svc = getAuthService();

  ipcMain.handle(CH.authLoginEmail, (_e, payload: LoginEmailPayload) =>
    wrap(() => svc.loginWithEmail(payload.email, payload.password))
  );

  ipcMain.handle(CH.authLoginBrowser, (_e, payload: LoginBrowserPayload) =>
    wrap(async () => {
      try {
        return await svc.loginWithBrowser(payload.provider);
      } catch {
        // Browser flow returns via deep link — acknowledge the request
        return { pending: true };
      }
    })
  );

  ipcMain.handle(CH.authLogout, () => wrap(() => svc.logout()));

  ipcMain.handle(CH.authGetUser, () =>
    wrap(() => ({
      user: svc.getUser(),
      authenticated: svc.isAuthenticated(),
    }))
  );

  svc.on('signed-in', (user) => emitToAll(CH.authChanged, { state: 'signed-in', user }));
  svc.on('signed-out', () => emitToAll(CH.authChanged, { state: 'signed-out' }));
  svc.on('session-expired', () => emitToAll(CH.authChanged, { state: 'expired' }));

  log.ipc.debug('auth IPC ready');
}
