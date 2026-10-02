import { type FlowCardTriggerDevice } from 'homey';
import SyncDevice, { OVERLAP_MS } from '../../lib/SyncDevice.mjs';
import { emptyScaleState, ingestBrews, parseBrew, type ScaleState } from '../../lib/events.mjs';

const notNull = <T,>(value: T | null): value is T => value !== null;

/** A Sync Scale: yield and shot time of every shot. No dose or ratio (that's the grinder's job). */
export default class SyncScaleDevice extends SyncDevice {
  private shotCompleted!: FlowCardTriggerDevice;

  protected async onSyncInit() {
    this.shotCompleted = this.homey.flow.getDeviceTriggerCard('scale_shot_completed');
  }

  async poll() {
    const now = Date.now();
    const scaleId = this.getData().id as string;
    const previous: ScaleState = { ...emptyScaleState(), ...(this.getStoreValue('tracker') as Partial<ScaleState> | null) };

    const brews = (await this.client.findBrewEvents(scaleId, this.windowStart(now, previous.lastBrew?.at ?? null), new Date(now + OVERLAP_MS)))
      .map(parseBrew)
      .filter(notNull);
    const update = ingestBrews(previous, brews, !previous.initialized);
    const state: ScaleState = { ...update.state, initialized: true };

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
}
