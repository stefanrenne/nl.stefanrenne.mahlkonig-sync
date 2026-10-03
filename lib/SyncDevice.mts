import Homey, { type FlowCardTriggerDevice } from 'homey';
import { SyncAuthError, SyncClient, type SyncCredentials } from './SyncClient.mjs';

export const MINUTE = 60_000;
const MAX_BACKOFF_MS = 30 * MINUTE;
/** How far back each poll looks for events, at most. */
const LOOKBACK_MS = 24 * 60 * MINUTE;
/** Read a little past "now", for clock skew between the grinder and Homey. */
export const OVERLAP_MS = 5 * MINUTE;
/** Events older than this when first seen (e.g. after Homey was offline) don't fire triggers. */
export const MAX_TRIGGER_AGE_MS = 60 * MINUTE;

/**
 * What every Mahlkönig Sync device shares: the client built from the stored credentials, the poll
 * loop with exponential backoff, availability, repair, and small capability/settings helpers.
 * Subclasses implement poll().
 */
export default abstract class SyncDevice extends Homey.Device {
  protected client!: SyncClient;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = false;

  async onInit() {
    this.client = this.createClient(this.credentials());
    await this.onSyncInit();
    this.scheduleNext(0);
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
      if (!this.getAvailable()) {
        await this.setAvailable();
      }
      this.scheduleNext(this.pollIntervalMs());
    } catch (error) {
      this.failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      this.error(`Poll failed (${this.failures} in a row): ${reason}`);
      const message = error instanceof SyncAuthError
        ? this.homey.__('errors.auth')
        : this.homey.__('errors.unreachable', { message: reason });
      await this.setUnavailable(message).catch((unavailableError) => this.error(unavailableError));
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
  }
}
