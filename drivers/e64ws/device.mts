import { type FlowCardTriggerDevice } from 'homey';
import { SyncApiError } from '../../lib/SyncClient.mjs';
import SyncDevice, { MINUTE, OVERLAP_MS } from '../../lib/SyncDevice.mjs';
import {
  doseForBrew,
  brewRatio,
  emptyTrackerState,
  ingestBrews,
  ingestGrinds,
  isPurge,
  parseBrew,
  parseGrind,
  realGrindBefore,
  rememberBrews,
  startedByPortafilter,
  type Brew,
  type Grind,
  type TrackerState,
} from '../../lib/events.mjs';
import { deviceName } from '../../lib/names.mjs';
import { timelineFromState, type TimelineEntry } from '../../lib/summary.mjs';

/** Realtime event the Espresso widget listens to, with `{ deviceId }`. */
export const WIDGET_UPDATED_EVENT = 'espresso.updated';

/** The status block (standby, temperature, firmware) changes slowly; fetch it less often. */
const STATUS_INTERVAL_MS = 10 * MINUTE;
const SCALE_CAPABILITIES = ['yield_weight', 'shot_time', 'brew_ratio'];
const REMOVED_CAPABILITIES = ['disc_usage', 'disc_health'];

const notNull = <T,>(value: T | null): value is T => value !== null;

export default class E64WSDevice extends SyncDevice {
  private lastStatusAt = -Infinity;
  private scaleId: string | number | null = null;
  private grindCompleted!: FlowCardTriggerDevice;
  private shotCompleted!: FlowCardTriggerDevice;

  protected async onSyncInit() {
    // Disc usage and disc health were shown before their meaning was known (docs/history.md).
    // Homey can only remove a capability the app still defines, so their definitions stay in
    // .homeycompose/capabilities/. A failure here must never stop the device from starting.
    for (const capability of REMOVED_CAPABILITIES) {
      if (this.hasCapability(capability)) {
        await this.removeCapability(capability)
          .catch((error) => this.error(`Removing ${capability} failed:`, error instanceof Error ? error.message : error));
      }
    }
    this.grindCompleted = this.homey.flow.getDeviceTriggerCard('grind_completed');
    this.shotCompleted = this.homey.flow.getDeviceTriggerCard('shot_completed');
  }

  /** What the Espresso widget shows: the last 24 hours, shots matched with their grinds. */
  widgetTimeline(now: number): TimelineEntry[] {
    return timelineFromState(this.trackerState(), now);
  }

  /** For the "Last grind was less than X minutes ago" condition. Purges don't count. */
  lastGrindWithin(minutes: number): boolean {
    const at = this.trackerState().lastRealGrind?.at;
    return at !== undefined && Date.now() - Date.parse(at) < minutes * MINUTE;
  }

  async poll() {
    const now = Date.now();
    const grinderId = this.getData().id as string;
    const previous = this.trackerState();
    const baseline = !previous.initialized;

    let statusRefreshed = false;
    if (baseline || now - this.lastStatusAt >= STATUS_INTERVAL_MS) {
      statusRefreshed = await this.refreshStatus(grinderId, now);
    }

    // Every poll reads the whole last 24 hours: the widget lists them all, and the recent lists
    // never miss an event that happened while an earlier poll looked at a shorter window.
    const from = this.lookbackStart(now);
    const to = new Date(now + OVERLAP_MS);
    const grinds = (await this.client.findGrindEvents(grinderId, from, to))
      .map(parseGrind)
      .filter(notNull);
    const threshold = this.purgeThresholdG();
    const grindUpdate = ingestGrinds(previous, grinds, threshold);

    let brews: Brew[] = [];
    if (this.scaleId !== null) {
      brews = (await this.client.findBrewEvents(this.scaleId, from, to))
        .map(parseBrew)
        .filter(notNull);
    }
    const brewUpdate = ingestBrews(grindUpdate.state, brews, baseline);
    // Every shot fetched, not only new ones, like the grinds.
    const state = rememberBrews(brewUpdate.state, brews);

    const purges = grinds.filter((grind) => isPurge(grind, threshold)).length;
    this.log(`Poll: ${grinds.length} grinds (${grindUpdate.newGrinds.length} new, ${purges} purges), ${brews.length} shots `
      + `(${brewUpdate.newBrews.length} new); keeping ${state.recentGrinds.length} grinds and ${state.recentBrews.length} shots`
      + `${baseline ? ' (baseline)' : ''}`);

    // Persist first, so a failure further down never makes the same event fire twice.
    await this.setStoreValue('tracker', state);
    await this.showGrind(state.lastRealGrind);
    if (state.lastBrew !== null) {
      await this.showBrew(state.lastBrew, realGrindBefore(state.lastBrew, [previous.lastRealGrind, ...grinds], threshold));
    }

    for (const grind of grindUpdate.newGrinds.filter((event) => this.isRecent(now, event.at))) {
      await this.trigger(this.grindCompleted, {
        dose: grind.doseG ?? 0,
        grind_setting: grind.grindSetting ?? 0,
        grind_time: grind.grindTimeS ?? 0,
        portafilter_detected: startedByPortafilter(grind),
        is_purge: isPurge(grind, threshold),
      });
    }
    for (const brew of brewUpdate.newBrews.filter((event) => this.isRecent(now, event.at))) {
      const dose = doseForBrew(brew, realGrindBefore(brew, [previous.lastRealGrind, ...grinds], threshold));
      await this.trigger(this.shotCompleted, {
        yield: brew.yieldG ?? 0,
        shot_time: brew.shotTimeS ?? 0,
        dose: dose ?? 0,
        ratio: brewRatio(brew.yieldG, dose) ?? 0,
      });
    }

    const changed = statusRefreshed
      || state.recentGrinds.length !== previous.recentGrinds.length
      || state.recentBrews.length !== previous.recentBrews.length
      || state.lastGrindAt !== previous.lastGrindAt
      || state.lastBrew?.uuid !== previous.lastBrew?.uuid;
    if (changed) {
      this.notifyWidget(grinderId);
    }
  }

  /** Tells open Espresso widgets to reload. A failure only costs a widget refresh. */
  private notifyWidget(grinderId: string) {
    try {
      this.homey.api.realtime(WIDGET_UPDATED_EVENT, { deviceId: grinderId });
    } catch (error) {
      this.error('Widget update failed:', error instanceof Error ? error.message : error);
    }
  }

  /** Refreshes standby, temperature, firmware and the paired scale. True when it succeeded. */
  private async refreshStatus(grinderId: string, now: number): Promise<boolean> {
    try {
      const device = await this.client.getDevice(grinderId);
      const status = device.status?.status;
      await this.show('standby', status?.standbyActive);
      await this.show('measure_temperature', status?.motorTemperature);

      const binding = await this.client.getScaleBinding(grinderId);
      this.scaleId = binding?.brewerId ?? binding?.brewer?.brewerId ?? null;
      if (this.scaleId !== null) {
        await this.addScaleCapabilities();
      }

      const firmware = [status?.hmiSwVersion, status?.espSwVersion].filter(Boolean).join(' / ');
      await this.updateLabels({
        model: deviceName(device),
        serial: device.serial ?? '-',
        firmware: firmware || '-',
        scale: binding?.brewer?.serial ?? (this.scaleId !== null ? String(this.scaleId) : this.homey.__('settings.noScale')),
      });
      this.lastStatusAt = now;
      return true;
    } catch (error) {
      // The status is extra information: don't let it block grind detection.
      if (!(error instanceof SyncApiError)) {
        throw error;
      }
      this.error(`Status refresh failed: ${error.message}`);
      return false;
    }
  }

  private async showGrind(grind: Grind | null) {
    if (grind === null) {
      return;
    }
    await this.show('dose_weight', grind.doseG);
    await this.show('grind_setting', grind.grindSetting);
    await this.show('grind_time', grind.grindTimeS);
    await this.show('last_grind', this.formatTime(grind.at));
    await this.show('dose_target', grind.doseTargetG);
    await this.show('grind_setting_target', grind.grindSettingTarget);
    await this.show('brew_time_target', grind.brewTimeTargetS);
    await this.show('recipe_mode', grind.recipeMode);
  }

  private async showBrew(brew: Brew, grind: Grind | null) {
    await this.addScaleCapabilities();
    await this.show('yield_weight', brew.yieldG);
    await this.show('shot_time', brew.shotTimeS);
    await this.show('brew_ratio', brewRatio(brew.yieldG, doseForBrew(brew, grind)));
  }

  private async addScaleCapabilities() {
    for (const capability of SCALE_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  private trackerState(): TrackerState {
    return { ...emptyTrackerState(), ...(this.getStoreValue('tracker') as Partial<TrackerState> | null) };
  }

  private purgeThresholdG(): number {
    const value = Number(this.getSetting('purge_threshold'));
    return Number.isFinite(value) && value >= 0 ? value : 5;
  }
}
