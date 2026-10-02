import type { SyncClient } from '../../lib/SyncClient.mjs';
import SyncDriver, { type PairDevice } from '../../lib/SyncDriver.mjs';
import { deviceName } from '../../lib/names.mjs';
import type E64WSDevice from './device.mjs';

export { deviceName };

export default class E64WSDriver extends SyncDriver {
  async onInit() {
    this.homey.flow.getConditionCard('last_grind_within')
      .registerRunListener(async (args: { device: E64WSDevice; minutes: number }) => args.device.lastGrindWithin(args.minutes));
  }

  protected async listDevices(client: SyncClient): Promise<PairDevice[]> {
    const grinders = await client.listGrinders();
    if (grinders.length === 0) {
      throw new Error(this.homey.__('pair.noGrinders'));
    }
    return grinders.map((grinder) => ({ name: deviceName(grinder), data: { id: String(grinder.deviceId) } }));
  }
}
