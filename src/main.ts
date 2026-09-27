// src/main.ts
import { app, BrowserWindow, ipcMain, systemPreferences, dialog } from 'electron';
import path from 'path';
import { createRequire } from 'module';

/* ==========================================================================
 * Native module resolution (must run before any require of native code)
 * ========================================================================== */

if (process.platform !== 'win32') {
  try {
    const npmRoot = require('child_process')
      .execSync('npm root', { encoding: 'utf8' })
      .trim();
    const sherpaLib = path.join(npmRoot, 'sherpa-onnx-node', 'lib');
    if (process.platform === 'darwin') {
      process.env.DYLD_LIBRARY_PATH = `${sherpaLib}:${process.env.DYLD_LIBRARY_PATH ?? ''}`;
    } else {
      process.env.LD_LIBRARY_PATH = `${sherpaLib}:${process.env.LD_LIBRARY_PATH ?? ''}`;
    }
  } catch {
    // Sherpa not installed — transcription will fall back to whisper.cpp
  }
}

/* ==========================================================================
 * Core modules
 * ========================================================================== */

import { logger, log, installCrashHandlers } from './core/logger';
import { getMachineInfo, machineSummary } from './core/machine-arch';
import { initJarvisCore } from './core/jarvis-core';
import { initAgentManager } from './core/agent-manager';

/* ==========================================================================
 * Services
 * ========================================================================== */

import { initAppState } from './services/app-state';
import { initAppSettingsService } from './services/app-settings-service';
import { initPrivacyConsentService } from './services/privacy-consent-service';
import { initSecureApiService } from './services/secure-api-service';
import { initAuthService } from './services/auth-service';
import { initWindowManager } from './services/window-manager';
import { initMenuService } from './services/menu-service';
import { initShortcutService } from './services/shortcut-service';
import { initPowerManagementService } from './services/power-management-service';
import { initUpdateService } from './services/update-service';
import { initTranscriptionService } from './services/transcription-service';
import { initAnalysisOverlayService } from './services/analysis-overlay-service';
import { initAppLifecycleService } from './services/app-lifecycle-service';
import { initStartupOptimizer } from './services/startup-optimizer';
import { initSetupStatusService } from './services/setup-status-service';
import { initNodeDictionary } from './services/node-dictionary';

/* ==========================================================================
 * Analytics
 * ========================================================================== */

import { configurePostHog } from './analytics/posthog';
import { initAnalytics, track } from './analytics/optimized-analytics-manager';

/* ==========================================================================
 * Transcription
 * ========================================================================== */

import { initSherpaModelManager, pickTranscriptionEngine } from './transcription';

/* ==========================================================================
 * Input / Audio / Context
 * ========================================================================== */

import { initUniversalKeyService } from './input/universal-key-service';
import { initWindowsKeyService } from './input/windows-key-service';
import { initPushToTalkController } from './input/push-to-talk-refactored';
import { initAudioProcessor } from './audio/processor';
import { initContextDetector } from './context/context-detector';
import { initSoundPlayer } from './utils/sound-player';

/* ==========================================================================
 * IPC + Local Server
 * ========================================================================== */

import { registerIpcHandlers } from './ipc/ipc-handlers';
import { startLocalServer, getLocalServer } from './server';

/* ==========================================================================
 * Protocol: jarvis://
 * ========================================================================== */

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('jarvis', process.execPath, [process.argv[1]]);
  }
} else {
  app.setAsDefaultProtocolClient('jarvis');
}

/* ==========================================================================
 * Single-instance lock (MUST run before whenReady)
 * ========================================================================== */

const lifecycle = initAppLifecycleService();
if (!lifecycle.acquireSingleInstance()) {
  // Another instance is running — this process exits
  process.exit(0);
}

/* ==========================================================================
 * Deep links
 * ========================================================================== */

function handleDeepLink(url: string): void {
  if (!url.startsWith('jarvis://')) return;
  log.main.info(`deep link: ${url}`);

  if (url.startsWith('jarvis://auth/callback')) {
    void import('./services/auth-service').then(({ getAuthService }) => {
      void getAuthService().handleOAuthCallback(url);
    });
  } else if (url.startsWith('jarvis://open')) {
    initWindowManager().focusOrCreate('main');
  }
}

function handleDeepLinkArgs(argv: string[]): void {
  for (const arg of argv) {
    if (arg.startsWith('jarvis://')) handleDeepLink(arg);
  }
}

/* ==========================================================================
 * Boot sequence
 * ========================================================================== */

app.whenReady().then(async () => {
  const boot = initStartupOptimizer();

  /* ---- 1. Logger + crash handlers -------------------------------------- */

  logger.init();
  installCrashHandlers();
  boot.mark('logger-ready');

  log.main.info(`═══════════════════════════════════════════════════════`);
  log.main.info(`  Jarvis ${app.getVersion()} booting`);
  log.main.info(`  ${machineSummary()}`);
  log.main.info(`  packaged: ${app.isPackaged}`);
  log.main.info(`═══════════════════════════════════════════════════════`);
  log.main.debug('machine info', getMachineInfo());

  /* ---- 2. App state (persisted settings, consent, auth) ---------------- */

  const state = initAppState();
  await state.load();
  boot.mark('state-loaded');

  /* ---- 3. Consent + settings ------------------------------------------- */

  initPrivacyConsentService();
  initAppSettingsService().init();
  boot.mark('settings-ready');

  /* ---- 4. Analytics (consent-gated) ------------------------------------ */

  configurePostHog({
    apiKey: process.env.POSTHOG_API_KEY ?? '',
    host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
    disabled: !process.env.POSTHOG_API_KEY || !app.isPackaged,
  });
  initAnalytics({ flushIntervalMs: 5000, maxBatchSize: 50 });
  track('app_started', { version: app.getVersion(), packaged: app.isPackaged });
  boot.mark('analytics-ready');

  /* ---- 5. Secure API + Auth -------------------------------------------- */

  initSecureApiService().init();
  initAuthService().init();
  boot.mark('auth-ready');

  /* ---- 6. Jarvis core + agent manager ---------------------------------- */

  const core = initJarvisCore({ preferLocal: true });
  const agents = initAgentManager(core);
  await core.start();
  boot.mark('core-ready');

  /* ---- 7. UI (windows, menu, overlay) ---------------------------------- */

  initWindowManager().init();
  initMenuService().init();
  initAnalysisOverlayService().init();
  boot.mark('ui-ready');

  /* ---- 8. Input (shortcuts, PTT, native key monitors) ------------------ */

  initShortcutService().init();
  initWindowsKeyService().init();
  await initUniversalKeyService().start();
  initPushToTalkController();
  boot.mark('input-ready');

  /* ---- 9. Audio + sound player ----------------------------------------- */

  initAudioProcessor({ targetSampleRate: 16000, silenceThreshold: 0.008 });
  initSoundPlayer({ volume: 0.7, maxConcurrent: 3 });
  boot.mark('audio-ready');

  /* ---- 10. Transcription engines -------------------------------------- */

  initSherpaModelManager();
  try {
    const engine = pickTranscriptionEngine();
    if (engine) {
      await initTranscriptionService().useEngine(engine);
    }
    boot.mark('transcription-ready');
  } catch (err) {
    log.transcription.error('failed to load transcription engine', err);
    // Non-fatal: cloud fallback still works
  }

  /* ---- 11. Context detector ------------------------------------------- */

  const ctx = initContextDetector({ pollIntervalMs: 1500 });
  await ctx.start();
  boot.mark('context-ready');

  /* ---- 12. Local dictionary (SQLite) ---------------------------------- */

  try {
    initNodeDictionary().init();
    boot.mark('dictionary-ready');
  } catch (err) {
    log.services.error('dictionary init failed', err);
  }

  /* ---- 13. Power management + updates + setup ------------------------- */

  initPowerManagementService().init();
  initUpdateService().init();
  initSetupStatusService().init();
  boot.mark('services-ready');

  /* ---- 14. IPC handlers (after all services are ready) ---------------- */

  registerIpcHandlers();
  boot.mark('ipc-ready');

  /* ---- 15. Local Fastify server --------------------------------------- */

  try {
    const { host, port, token } = await startLocalServer({
      port: Number(process.env.JARVIS_PORT ?? 43117),
      verbose: !app.isPackaged,
    });

    ipcMain.handle('server:info', () => ({ host, port, token }));

    log.main.info(`local server: http://${host}:${port}`);
    boot.mark('server-ready');
  } catch (err) {
    log.server.error('local server failed to start', err);
  }

  /* ---- 16. Lifecycle handlers ----------------------------------------- */

  lifecycle.install();
  boot.mark('lifecycle-ready');

  /* ---- 17. Show the correct window ------------------------------------ */

  const settings = state.getSettings();
  const setup = state.getSetup();
  const wm = initWindowManager();

  if (!setup.onboardingComplete) {
    wm.focusOrCreate('onboarding');
  } else {
    wm.focusOrCreate('main');
  }
  boot.mark('window-shown');

  /* ---- 18. Deferred work (agents, warmups) ---------------------------- */

  boot.defer('agents-start', async () => {
    try {
      await agents.startAll();
    } catch (err) {
      log.main.error('agent startup failed', err);
    }
  });

  boot.defer('warmup', async () => {
    // Warm up the transcription engine with a silent buffer
    try {
      const svc = initTranscriptionService();
      if (svc.getEngineName() !== 'none') {
        await svc.transcribe({
          pcm: new Float32Array(16000),
          sampleRate: 16000,
        });
      }
    } catch {
      // Silent warmup failure is fine
    }
  });

  await boot.runDeferred(2000);

  log.main.info('✓ boot complete');
  track('app_ready', { bootMs: Date.now() });

  /* ---- 19. Send the local server info to the renderer ------------------ */

  // Wait for the window to be ready, then push server info
  const main = wm.get('main') ?? wm.get('onboarding');
  if (main) {
    main.webContents.once('did-finish-load', () => {
      try {
        const srv = getLocalServer();
        main.webContents.send('server:ready', {
          host: '127.0.0.1',
          port: srv.getPort(),
          token: srv.getToken(),
        });
      } catch {
        /* server not started */
      }
    });
  }
});

/* ==========================================================================
 * Lifecycle events
 * ========================================================================== */

app.on('second-instance', (_event, argv) => {
  handleDeepLinkArgs(argv);
  const wm = initWindowManager();
  const main = wm.get('main');
  if (main) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  } else {
    wm.focusOrCreate('main');
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.on('activate', () => {
  const wm = initWindowManager();
  if (BrowserWindow.getAllWindows().length === 0) {
    wm.focusOrCreate('main');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/* ==========================================================================
 * Shutdown
 * ========================================================================== */

let shuttingDown = false;

app.on('before-quit', async (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;

  log.main.info('shutting down…');

  try {
    // Stop the local server first (stop accepting new work)
    await getLocalServer().stop().catch(() => {});
  } catch { /* ignore */ }

  try {
    // Stop input + audio (stop new events)
    const { getPushToTalkController } = await import('./input/push-to-talk-refactored');
    getPushToTalkController().dispose();
  } catch { /* ignore */ }

  try {
    const { getUniversalKeyService } = await import('./input/universal-key-service');
    getUniversalKeyService().stop();
  } catch { /* ignore */ }

  try {
    const { getContextDetector } = await import('./context/context-detector');
    getContextDetector().stop();
  } catch { /* ignore */ }

  try {
    const { getSoundPlayer } = await import('./utils/sound-player');
    getSoundPlayer().stopAll();
  } catch { /* ignore */ }

  try {
    const { getUpdateService } = await import('./services/update-service');
    getUpdateService().dispose();
  } catch { /* ignore */ }

  try {
    const { getMenuService } = await import('./services/menu-service');
    getMenuService().dispose();
  } catch { /* ignore */ }

  try {
    const { getShortcutService } = await import('./services/shortcut-service');
    getShortcutService().dispose();
  } catch { /* ignore */ }

  try {
    const { getNodeDictionary } = await import('./services/node-dictionary');
    getNodeDictionary().dispose();
  } catch { /* ignore */ }

  try {
    const { getAnalysisOverlayService } = await import('./services/analysis-overlay-service');
    getAnalysisOverlayService().dispose();
  } catch { /* ignore */ }

  try {
    const { getJarvisCore } = await import('./core/jarvis-core');
    await getJarvisCore().stop();
  } catch { /* ignore */ }

  try {
    const { getAppState } = await import('./services/app-state');
    await getAppState().save();
  } catch { /* ignore */ }

  await logger.close();

  log.main.info('shutdown complete');
  app.exit(0);
});

/* ==========================================================================
 * macOS permission pre-check (non-blocking)
 * ========================================================================== */

if (process.platform === 'darwin') {
  app.whenReady().then(async () => {
    // On first launch, if accessibility isn't granted, we don't force the
    // prompt here — the onboarding flow handles it via SetupStatusService.
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (!trusted) {
      log.main.warn('Accessibility permission not granted — PTT will not work until enabled');
    }
  });
}
