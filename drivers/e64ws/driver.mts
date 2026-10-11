import type { SyncClient } from '../../lib/SyncClient.mjs';
import SyncDriver, { type PairDevice } from '../../lib/SyncDriver.mjs';
import { deviceName } from '../../lib/names.mjs';
import type E64WSDevice from './device.mjs';

export { deviceName };

export default class E64WSDriver extends SyncDriver {
  async onInit() {
    this.logDiscovery();
    this.homey.flow.getConditionCard('last_grind_within')
      .registerRunListener(async (args: { device: E64WSDevice; minutes: number }) => args.device.lastGrindWithin(args.minutes));
  }

  /**
   * Logs which `_workstation._tcp` announcements Homey sees, to diagnose the grinder's mDNS
   * discovery (TODO.md). Names only; no credentials or cloud data.
   */
  private logDiscovery() {
    try {
      const strategy = this.getDiscoveryStrategy();
      const describe = (result: { name?: string; host?: string; address?: string }) => `${result.name ?? '?'} (${result.host ?? '?'}, ${result.address ?? '?'})`;
      const current = Object.values(strategy.getDiscoveryResults()) as { name?: string; host?: string; address?: string }[];
      this.log(`mDNS workstation announcements at start-up: ${current.length ? current.map(describe).join('; ') : 'none'}`);
      strategy.on('result', (result: { name?: string; host?: string; address?: string }) => this.log(`mDNS workstation announcement: ${describe(result)}`));
    } catch (error) {
      this.error('mDNS discovery unavailable:', error instanceof Error ? error.message : error);
    }
  }

  protected async listDevices(client: SyncClient): Promise<PairDevice[]> {
    const grinders = await client.listGrinders();
    if (grinders.length === 0) {
      throw new Error(this.homey.__('pair.noGrinders'));
    }
    return grinders.map((grinder) => ({ name: deviceName(grinder), data: { id: String(grinder.deviceId) } }));
  }
}
