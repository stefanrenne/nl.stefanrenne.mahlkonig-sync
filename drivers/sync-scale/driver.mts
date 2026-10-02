import type { RawScale, SyncClient } from '../../lib/SyncClient.mjs';
import SyncDriver, { type PairDevice } from '../../lib/SyncDriver.mjs';
import { deviceName } from '../../lib/names.mjs';

export default class SyncScaleDriver extends SyncDriver {
  protected async listDevices(client: SyncClient): Promise<PairDevice[]> {
    const scales = await client.listScales();
    if (scales.length === 0) {
      throw new Error(this.homey.__('pair.noScales'));
    }
    return scales.map((scale) => ({
      name: 'Sync Scale',
      data: { id: String(scale.deviceId) },
      settings: { serial: scale.serial ?? '-', grinder: this.pairedGrinder(scale) },
    }));
  }

  /** "Mahlkönig E64 WS (SERIAL)" for the grinder the scale is paired with in Sync. */
  private pairedGrinder(scale: RawScale): string {
    const grinder = scale.bindings?.find((binding) => binding.toDevice !== undefined)?.toDevice;
    if (grinder === undefined) {
      return this.homey.__('settings.noGrinder');
    }
    return grinder.serial ? `${deviceName(grinder)} (${grinder.serial})` : deviceName(grinder);
  }
}
