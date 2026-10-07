import type { SyncClient } from '../../lib/SyncClient.mjs';
import SyncDriver, { type PairDevice } from '../../lib/SyncDriver.mjs';
import { pairedGrinderName } from '../../lib/names.mjs';

export default class SyncScaleDriver extends SyncDriver {
  protected async listDevices(client: SyncClient): Promise<PairDevice[]> {
    const scales = await client.listScales();
    if (scales.length === 0) {
      throw new Error(this.homey.__('pair.noScales'));
    }
    return scales.map((scale) => ({
      name: 'Sync Scale',
      data: { id: String(scale.deviceId) },
      settings: { serial: scale.serial ?? '-', grinder: pairedGrinderName(scale) ?? this.homey.__('settings.noGrinder') },
    }));
  }
}
