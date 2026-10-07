import { type FlowCardTriggerDevice } from 'homey';
import { SyncApiError } from '../../lib/SyncClient.mjs';
import SyncDevice, { MINUTE, OVERLAP_MS } from '../../lib/SyncDevice.mjs';
import { pairedGrinderName } from '../../lib/names.mjs';
import { emptyScaleState, ingestBrews, parseBrew, type ScaleState } from '../../lib/events.mjs';

const notNull = <T,>(value: T | null): value is T => value !== null;
/** How often the serial and paired-grinder labels are refreshed (the scale can be re-paired). */
const INFO_INTERVAL_MS = 10 * MINUTE;

/** A Sync Scale: yield and shot time of every shot. No dose or ratio (that's the grinder's job). */
export default class SyncScaleDevice extends SyncDevice {
  private shotCompleted!: FlowCardTriggerDevice;
  private lastInfoAt = -Infinity;

  protected async onSyncInit() {
    this.shotCompleted = this.homey.flow.getDeviceTriggerCard('scale_shot_completed');
  }

  async poll() {
    const now = Date.now();
    const scaleId = this.getData().id as string;
    const previous: ScaleState = { ...emptyScaleState(), ...(this.getStoreValue('tracker') as Partial<ScaleState> | null) };
    if (now - this.lastInfoAt >= INFO_INTERVAL_MS) {
      await this.refreshInfo(scaleId, now);
    }

    const brews = (await this.client.findBrewEvents(scaleId, this.lookbackStart(now), new Date(now + OVERLAP_MS)))
      .map(parseBrew)
      .filter(notNull);
    const update = ingestBrews(previous, brews, !previous.initialized);
    const state: ScaleState = { ...update.state, initialized: true };

    this.log(`Poll: ${brews.length} shots (${update.newBrews.length} new)${previous.initialized ? '' : ' (baseline)'}`);

    // Persist first, so a failure further down never makes the same shot fire twice.
    await this.setStoreValue('tracker', state);
    if (state.lastBrew !== null) {
      await this.show('yield_weight', state.lastBrew.yieldG);
      await this.show('shot_time', state.lastBrew.shotTimeS);
      await this.show('last_shot', this.formatTime(state.lastBrew.at));
    }

    for (const brew of update.newBrews.filter((event) => this.isRecent(now, event.at))) {
      await this.trigger(this.shotCompleted, { yield: brew.yieldG ?? 0, shot_time: brew.shotTimeS ?? 0 });
    }
  }

  /** Refreshes the serial and paired-grinder labels. Extra information: a cloud error is only logged. */
  private async refreshInfo(scaleId: string, now: number) {
    try {
      const scale = (await this.client.listScales()).find((candidate) => String(candidate.deviceId) === scaleId);
      if (scale !== undefined) {
        await this.updateLabels({
          serial: scale.serial ?? '-',
          grinder: pairedGrinderName(scale) ?? this.homey.__('settings.noGrinder'),
        });
      }
      this.lastInfoAt = now;
    } catch (error) {
      if (!(error instanceof SyncApiError)) {
        throw error;
      }
      this.error(`Scale info refresh failed: ${error.message}`);
    }
  }
}
