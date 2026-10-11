import Homey, { type FlowCardTriggerDevice } from 'homey';
import { SyncAuthError, SyncClient, type SyncCredentials } from './SyncClient.mjs';
import { probeHost } from './presence.mjs';

export const MINUTE = 60_000;
const MAX_BACKOFF_MS = 30 * MINUTE;
/** How far back each poll looks for events, at most. */
const LOOKBACK_MS = 24 * 60 * MINUTE;
/** Read a little past "now", for clock skew between the grinder and Homey. */
export const OVERLAP_MS = 5 * MINUTE;
/** Events older than this when first seen (e.g. after Homey was offline) don't fire triggers. */
export const MAX_TRIGGER_AGE_MS = 60 * MINUTE;
/** How often the local network presence ("Online") is checked. */
export const PRESENCE_INTERVAL_MS = 30_000;

/**
 * What every Mahlkönig Sync device shares: the client built from the stored credentials, the poll
 * loop with exponential backoff, availability, repair, and small capability/settings helpers.
 * Subclasses implement poll().
 */
export default abstract class SyncDevice extends Homey.Device {
  protected client!: SyncClient;
  private timer: NodeJS.Timeout | undefined;
  private presenceTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = false;
  /** Why the cloud can't be read right now (shown as the unavailable message), or null. */
  private cloudProblem: string | null = null;
  /** True when the device's local address doesn't answer: it's off or off the network. */
  private offline = false;
  /** The message last passed to setUnavailable, so repeated checks don't repeat the call. */
  private unavailableMessage: string | null = null;

  async onInit() {
    this.client = this.createClient(this.credentials());
    await this.onSyncInit();
    // An earlier build showed presence as an "online" capability; it's the device's availability
    // now. The capability's definition stays in .homeycompose/capabilities/ so Homey accepts this.
    if (this.hasCapability('online')) {
      await this.removeCapability('online').catch((error) => this.error('Removing online failed:', error instanceof Error ? error.message : error));
    }
    this.scheduleNext(0);
    this.presenceTimer = this.homey.setInterval(() => {
      this.checkPresence().catch((error) => this.error(error));
    }, PRESENCE_INTERVAL_MS);
    this.checkPresence().catch((error) => this.error(error));
  }

  /**
   * The device's local IP address found automatically (mDNS for the grinder, the router's DNS for
   * the scale), or null. Overridden by the drivers.
   */
  protected async resolveAddress(): Promise<string | null> {
    return null;
  }

  /** The unavailable message when the device doesn't answer on the local network. */
  protected abstract offlineMessage(): string;

  /** Whether the address answers on the local network. Overridden in tests. */
  protected probe(address: string): Promise<boolean> {
    return probeHost(address);
  }

  /**
   * Checks whether the device is on the local network: finds the address (falling back to the
   * `ip_address` setting), stores a newly found address in that setting, probes it, and marks the
   * device unavailable when it doesn't answer. Without any known address the device counts as
   * present (unknown is not offline). Never throws.
   */
  async checkPresence(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const detected = await this.resolveAddress().catch(() => null);
      const configured = String(this.getSetting('ip_address') ?? '').trim() || null;
      if (detected !== null && detected !== configured) {
        await this.setSettings({ ip_address: detected });
      }
      const address = detected ?? configured;
      this.offline = address === null ? false : !(await this.probe(address));
      await this.applyAvailability();
    } catch (error) {
      this.error('Presence check failed:', error instanceof Error ? error.message : error);
    }
  }

  /** Available only when the cloud can be read and the device answers; a cloud problem's message wins. */
  private async applyAvailability() {
    const message = this.cloudProblem ?? (this.offline ? this.offlineMessage() : null);
    if (message === null) {
      if (!this.getAvailable()) {
        await this.setAvailable();
      }
      this.unavailableMessage = null;
    } else if (this.getAvailable() || message !== this.unavailableMessage) {
      await this.setUnavailable(message);
      this.unavailableMessage = message;
    }
  }

  /** Subclass setup that runs before the first poll. */
  protected async onSyncInit() {}

  /** One poll: fetch new data, update capabilities, fire triggers. Throw on failure. */
  abstract poll(): Promise<void>;

  /** Overridden in tests. */
  createClient(credentials: SyncCredentials): SyncClient {
    return new SyncClient(credentials);
  }

  /** Called by the repair flow with credentials that were just validated. */
  async updateCredentials(credentials: SyncCredentials) {
    await this.setStoreValue('email', credentials.email);
    await this.setStoreValue('password', credentials.password);
    this.client = this.createClient(credentials);
    this.failures = 0;
    this.scheduleNext(0);
  }

  async onSettings({ newSettings, changedKeys }: { newSettings: { [key: string]: unknown }; changedKeys: string[] }) {
    if (changedKeys.includes('poll_interval')) {
      this.scheduleNext(this.pollIntervalMs(newSettings.poll_interval));
    }
    if (changedKeys.includes('ip_address')) {
      // After Homey saved the new address, so the check reads it.
      this.homey.setTimeout(() => {
        this.checkPresence().catch((error) => this.error(error));
      }, 1_000);
    }
  }

  async onUninit() {
    this.stop();
  }

  onDeleted() {
    this.stop();
  }

  /** One poll plus scheduling the next one. Never throws. */
  async tick() {
    try {
      await this.poll();
      this.failures = 0;
      this.cloudProblem = null;
      await this.applyAvailability();
      this.scheduleNext(this.pollIntervalMs());
    } catch (error) {
      this.failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      this.error(`Poll failed (${this.failures} in a row): ${reason}`);
      this.cloudProblem = error instanceof SyncAuthError
        ? this.homey.__('errors.auth')
        : this.homey.__('errors.unreachable', { message: reason });
      await this.applyAvailability().catch((unavailableError) => this.error(unavailableError));
      this.scheduleNext(this.backoffMs());
    }
  }

  /** Sets a capability when the device has it, the value is known and it changed. */
  protected async show(capability: string, value: number | string | boolean | null | undefined) {
    if (value === null || value === undefined || !this.hasCapability(capability)) {
      return;
    }
    if (this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
    }
  }

  /**
   * Like show(), but an unknown value clears the capability instead of keeping the old one: for
   * values that belong to one event, where an old value would be misleading.
   */
  protected async showOrClear(capability: string, value: number | string | boolean | null | undefined) {
    if (!this.hasCapability(capability)) {
      return;
    }
    const next = value ?? null;
    if (this.getCapabilityValue(capability) !== next) {
      await this.setCapabilityValue(capability, next);
    }
  }

  /** Writes read-only label settings that changed. */
  protected async updateLabels(labels: Record<string, string>) {
    const changed = Object.fromEntries(Object.entries(labels).filter(([key, value]) => this.getSetting(key) !== value));
    if (Object.keys(changed).length > 0) {
      await this.setSettings(changed);
    }
  }

  /** Fires a trigger card; a failure is logged and doesn't fail the poll. */
  protected async trigger(card: FlowCardTriggerDevice, tokens: Record<string, number | string | boolean>) {
    try {
      await card.trigger(this, tokens);
    } catch (error) {
      this.error(`Triggering ${card.id} failed:`, error instanceof Error ? error.message : error);
    }
  }

  /** A short date and time in the Homey's language and time zone. */
  protected formatTime(iso: string): string {
    return new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: this.homey.clock.getTimezone(),
    }).format(new Date(iso));
  }

  /** Start of a poll window: 24 hours back. Every poll reads the whole window. */
  protected lookbackStart(now: number): Date {
    return new Date(now - LOOKBACK_MS);
  }

  /** True when an event is recent enough to fire a trigger. */
  protected isRecent(now: number, at: string): boolean {
    return now - Date.parse(at) <= MAX_TRIGGER_AGE_MS;
  }

  private credentials(): SyncCredentials {
    return { email: this.getStoreValue('email') as string, password: this.getStoreValue('password') as string };
  }

  private pollIntervalMs(setting: unknown = this.getSetting('poll_interval')): number {
    return Math.max(1, Number(setting) || 2) * MINUTE;
  }

  private backoffMs(): number {
    return Math.min(this.pollIntervalMs() * 2 ** this.failures, MAX_BACKOFF_MS);
  }

  private scheduleNext(delayMs: number) {
    if (this.timer !== undefined) {
      this.homey.clearTimeout(this.timer);
    }
    if (this.stopped) {
      return;
    }
    this.timer = this.homey.setTimeout(() => {
      this.tick().catch((error) => this.error(error));
    }, delayMs);
  }

  private stop() {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.homey.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.presenceTimer !== undefined) {
      this.homey.clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
    }
  }
}
