// src/services/power-management-service.ts
import { powerMonitor, powerSaveBlocker } from 'electron';
import { EventEmitter } from 'events';
import { log } from '../core/logger';

export interface PowerEvents {
  'suspend': void;
  'resume': void;
  'lock': void;
  'unlock': void;
  'ac': void;
  'battery': void;
}

export class PowerManagementService extends EventEmitter {
  private blockerId: number | null = null;

  init(): void {
    powerMonitor.on('suspend', () => {
      log.services.info('system suspend');
      this.emit('suspend');
    });
    powerMonitor.on('resume', () => {
      log.services.info('system resume');
      this.emit('resume');
    });
    powerMonitor.on('lock-screen', () => this.emit('lock'));
    powerMonitor.on('unlock-screen', () => this.emit('unlock'));
    powerMonitor.on('on-ac', () => this.emit('ac'));
    powerMonitor.on('on-battery', () => this.emit('battery'));

    log.services.info('power-management-service ready');
  }

  /** Prevent display sleep — useful during long transcription or analysis. */
  preventSleep(): void {
    if (this.blockerId !== null) return;
    this.blockerId = powerSaveBlocker.start('prevent-display-sleep');
    log.services.debug('sleep blocker started');
  }

  allowSleep(): void {
    if (this.blockerId === null) return;
    if (powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId);
    }
    this.blockerId = null;
    log.services.debug('sleep blocker stopped');
  }

  isOnBattery(): boolean {
    return powerMonitor.isOnBatteryPower();
  }

  /* ---- Typed emit/on ---------------------------------------------------- */

  override emit<K extends keyof PowerEvents>(event: K, payload: PowerEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof PowerEvents>(
    event: K,
    listener: (payload: PowerEvents[K]) => void
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

let instance: PowerManagementService | null = null;
export function initPowerManagementService(): PowerManagementService {
  if (instance) return instance;
  instance = new PowerManagementService();
  return instance;
}
export function getPowerManagementService(): PowerManagementService {
  if (!instance) throw new Error('PowerManagementService not initialized');
  return instance;
}
