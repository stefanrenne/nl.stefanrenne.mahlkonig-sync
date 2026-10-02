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
  startedByPortafilter,
  type Brew,
  type Grind,
  type TrackerState,
} from '../../lib/events.mjs';
import { deviceName } from '../../lib/names.mjs';

/** The status block (standby, temperature, firmware) changes slowly; fetch it less often. */
const STATUS_INTERVAL_MS = 10 * MINUTE;
const SCALE_CAPABILITIES = ['yield_weight', 'shot_time', 'brew_ratio'];

const notNull = <T,>(value: T | null): value is T => value !== null;

export default class E64WSDevice extends SyncDevice {
  private lastStatusAt = -Infinity;
  private scaleId: string | number | null = null;
  private grindCompleted!: FlowCardTriggerDevice;
  private shotCompleted!: FlowCardTriggerDevice;

  protected async onSyncInit() {
    this.grindCompleted = this.homey.flow.getDeviceTriggerCard('grind_completed');
    this.shotCompleted = this.homey.flow.getDeviceTriggerCard('shot_completed');
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

    if (baseline || now - this.lastStatusAt >= STATUS_INTERVAL_MS) {
      await this.refreshStatus(grinderId, now);
    }

    const to = new Date(now + OVERLAP_MS);
    const grinds = (await this.client.findGrindEvents(grinderId, this.windowStart(now, previous.lastGrindAt), to))
      .map(parseGrind)
      .filter(notNull);
    const threshold = this.purgeThresholdG();
    const grindUpdate = ingestGrinds(previous, grinds, threshold);

    let brews: Brew[] = [];
    if (this.scaleId !== null) {
      brews = (await this.client.findBrewEvents(this.scaleId, this.windowStart(now, previous.lastBrew?.at ?? null), to))
        .map(parseBrew)
        .filter(notNull);
    }
    const brewUpdate = ingestBrews(grindUpdate.state, brews, baseline);
    const state = brewUpdate.state;

    // Persist first, so a failure further down never makes the same event fire twice.
    await this.setStoreValue('tracker', state);
    await this.showGrind(state.lastRealGrind);
    if (state.lastBrew !== null) {
      await this.showBrew(state.lastBrew, this.realGrindBefore(state.lastBrew, previous.lastRealGrind, grinds, threshold));
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
      const dose = doseForBrew(brew, this.realGrindBefore(brew, previous.lastRealGrind, grinds, threshold));
      await this.trigger(this.shotCompleted, {
        yield: brew.yieldG ?? 0,
        shot_time: brew.shotTimeS ?? 0,
        dose: dose ?? 0,
        ratio: brewRatio(brew.yieldG, dose) ?? 0,
      });
    }
  }

  private async refreshStatus(grinderId: string, now: number) {
    try {
      const device = await this.client.getDevice(grinderId);
      const status = device.status?.status;
      await this.show('standby', status?.standbyActive);
      await this.show('measure_temperature', status?.motorTemperature);
      await this.show('disc_usage', status?.discUsageTime);
      await this.show('disc_health', status?.discHealth);

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
    } catch (error) {
      // The status is extra information: don't let it block grind detection.
      if (!(error instanceof SyncApiError)) {
        throw error;
      }
      this.error(`Status refresh failed: ${error.message}`);
    }
  }

  /** The newest real (non-purge) grind at or before the shot, from the previous state and this poll. */
  private realGrindBefore(brew: Brew, previousReal: Grind | null, grinds: Grind[], threshold: number): Grind | null {
    const shotAt = Date.parse(brew.at);
    return [previousReal, ...grinds.filter((grind) => !isPurge(grind, threshold))]
      .filter(notNull)
      .filter((grind) => Date.parse(grind.at) <= shotAt)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
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
