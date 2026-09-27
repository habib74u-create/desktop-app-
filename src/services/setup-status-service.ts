// src/services/setup-status-service.ts
import { systemPreferences } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getAppState } from './app-state';
import { getPrivacyConsentService } from './privacy-consent-service';

export interface SetupChecklist {
  termsAccepted: boolean;
  privacyAccepted: boolean;
  micPermission: boolean;
  accessibilityPermission: boolean;
  modelsReady: boolean;
  onboardingComplete: boolean;
}

export interface SetupEvents {
  'checklist:changed': SetupChecklist;
  'setup:complete': void;
}

export class SetupStatusService extends EventEmitter {
  private state = getAppState();
  private consent = getPrivacyConsentService();

  init(): void {
    log.services.info('setup-status-service ready');
  }

  getChecklist(): SetupChecklist {
    const consent = this.state.getConsent();
    const setup = this.state.getSetup();
    return {
      termsAccepted: consent.termsAcceptedAt !== null,
      privacyAccepted: consent.privacyAcceptedAt !== null,
      micPermission: this.checkMicPermission(),
      accessibilityPermission: this.checkAccessibility(),
      modelsReady: setup.modelsReady,
      onboardingComplete: setup.onboardingComplete,
    };
  }

  isComplete(): boolean {
    const c = this.getChecklist();
    return (
      c.termsAccepted &&
      c.privacyAccepted &&
      c.micPermission &&
      c.accessibilityPermission &&
      c.modelsReady &&
      c.onboardingComplete
    );
  }

  markModelsReady(): void {
    this.state.updateSetup({ modelsReady: true });
    this.emitChange();
    log.services.info('models ready');
  }

  markOnboardingComplete(): void {
    this.state.updateSetup({ onboardingComplete: true, firstRunAt: Date.now() });
    this.emitChange();
    if (this.isComplete()) this.emit('setup:complete');
  }

  /** Re-check permissions (call after returning from System Settings). */
  refresh(): SetupChecklist {
    const checklist = this.getChecklist();
    if (checklist.micPermission && checklist.accessibilityPermission) {
      this.state.updateSetup({ permissionsReady: true });
    }
    this.emitChange();
    return checklist;
  }

  /* ---- Platform checks -------------------------------------------------- */

  private checkMicPermission(): boolean {
    if (process.platform !== 'darwin') return true; // handled at record time
    const status = systemPreferences.getMediaAccessStatus('microphone');
    return status === 'granted';
  }

  private checkAccessibility(): boolean {
    if (process.platform !== 'darwin') return true;
    try {
      return systemPreferences.isTrustedAccessibilityClient(false);
    } catch {
      return false;
    }
  }

  private emitChange(): void {
    this.emit('checklist:changed', this.getChecklist());
  }

  override emit<K extends keyof SetupEvents>(event: K, payload: SetupEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof SetupEvents>(
    event: K,
    listener: (payload: SetupEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

let instance: SetupStatusService | null = null;
export function initSetupStatusService(): SetupStatusService {
  if (instance) return instance;
  instance = new SetupStatusService();
  return instance;
}
export function getSetupStatusService(): SetupStatusService {
  if (!instance) throw new Error('SetupStatusService not initialized');
  return instance;
}
