// src/services/privacy-consent-service.ts
import { dialog, shell, app } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';
import { getAppState, type ConsentRecord } from './app-state';

export class PrivacyConsentService extends EventEmitter {
  private state = getAppState();

  init(): void {
    log.services.info('privacy-consent-service ready');
  }

  /* ---- Consent status --------------------------------------------------- */

  get(): Readonly<ConsentRecord> {
    return this.state.getConsent();
  }

  hasAcceptedTerms(): boolean {
    return this.state.getConsent().termsAcceptedAt !== null;
  }

  hasAcceptedPrivacy(): boolean {
    return this.state.getConsent().privacyAcceptedAt !== null;
  }

  hasAnalyticsConsent(): boolean {
    return this.state.getConsent().analyticsConsentAt !== null;
  }

  /* ---- Consent actions -------------------------------------------------- */

  acceptTerms(): void {
    this.state.updateConsent({ termsAcceptedAt: Date.now() });
    log.services.info('terms accepted');
    this.emit('terms:accepted');
  }

  acceptPrivacy(): void {
    this.state.updateConsent({ privacyAcceptedAt: Date.now() });
    log.services.info('privacy policy accepted');
    this.emit('privacy:accepted');
  }

  setAnalyticsConsent(enabled: boolean): void {
    this.state.updateConsent({
      analyticsConsentAt: enabled ? Date.now() : null,
    });
    log.services.info(`analytics consent: ${enabled}`);
    this.emit('analytics:changed', enabled);
  }

  acknowledgeMicrophone(): void {
    this.state.updateConsent({ micAcknowledgedAt: Date.now() });
    this.emit('mic:acknowledged');
  }

  acknowledgeAccessibility(): void {
    this.state.updateConsent({ accessibilityAcknowledgedAt: Date.now() });
    this.emit('accessibility:acknowledged');
  }

  /* ---- UI helpers ------------------------------------------------------- */

  /**
   * Show the first-run consent dialog. Returns true if both accepted.
   */
  async showFirstRunDialog(): Promise<boolean> {
    if (this.hasAcceptedTerms() && this.hasAcceptedPrivacy()) return true;

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Welcome to Jarvis',
      message: 'Before we begin',
      detail:
        'Jarvis processes voice and screen content locally whenever possible.\n\n' +
        'By continuing you agree to our Terms of Service and Privacy Policy.',
      buttons: ['View Terms', 'View Privacy', 'Accept & Continue', 'Quit'],
      defaultId: 2,
      cancelId: 3,
      noLink: true,
    });

    if (response === 0) {
      await shell.openExternal('https://example.com/terms');
      return this.showFirstRunDialog();
    }
    if (response === 1) {
      await shell.openExternal('https://example.com/privacy');
      return this.showFirstRunDialog();
    }
    if (response === 3) {
      app.quit();
      return false;
    }

    this.acceptTerms();
    this.acceptPrivacy();
    return true;
  }
}

let instance: PrivacyConsentService | null = null;
export function initPrivacyConsentService(): PrivacyConsentService {
  if (instance) return instance;
  instance = new PrivacyConsentService();
  return instance;
}
export function getPrivacyConsentService(): PrivacyConsentService {
  if (!instance) throw new Error('PrivacyConsentService not initialized');
  return instance;
}
