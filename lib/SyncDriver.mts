import Homey from 'homey';
import { SyncAuthError, SyncClient, type SyncCredentials } from './SyncClient.mjs';
import type SyncDevice from './SyncDevice.mjs';

// PairSession isn't exported from the `homey` types entry; take it from the method signature.
export type PairSession = Parameters<Homey.Driver['onPair']>[0];

interface LoginData {
  username: string;
  password: string;
}

/** A device as list_devices returns it, before the credentials are added to its store. */
export interface PairDevice {
  name: string;
  data: { id: string };
  settings?: Record<string, string>;
}

/**
 * Pairing and repair shared by every driver: log in with the Sync account (login_credentials),
 * then list the account's devices of this driver's kind (list_devices). Subclasses implement
 * listDevices().
 */
export default abstract class SyncDriver extends Homey.Driver {
  /** The account's devices this driver can add. Throw a translated error when there are none. */
  protected abstract listDevices(client: SyncClient): Promise<PairDevice[]>;

  /** Overridden in tests. */
  createClient(credentials: SyncCredentials): SyncClient {
    return new SyncClient(credentials);
  }

  async onPair(session: PairSession) {
    let credentials: SyncCredentials | undefined;
    let client: SyncClient | undefined;

    session.setHandler('login', async (data: LoginData) => {
      const candidate = { email: data.username.trim(), password: data.password };
      const candidateClient = this.createClient(candidate);
      if (!(await this.checkLogin(candidateClient))) {
        return false;
      }
      credentials = candidate;
      client = candidateClient;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (client === undefined || credentials === undefined) {
        throw new Error(this.homey.__('pair.unreachable'));
      }
      const devices = await this.listDevices(client);
      // Credentials live in the device store and are never logged.
      return devices.map((device) => ({ ...device, store: { email: credentials?.email, password: credentials?.password } }));
    });
  }

  async onRepair(session: PairSession, device: Homey.Device) {
    session.setHandler('login', async (data: LoginData) => {
      const candidate = { email: data.username.trim(), password: data.password };
      const client = this.createClient(candidate);
      if (!(await this.checkLogin(client))) {
        return false;
      }
      const devices = await this.listDevices(client);
      if (!devices.some((listed) => listed.data.id === device.getData().id)) {
        throw new Error(this.homey.__('pair.wrongAccount'));
      }
      await (device as SyncDevice).updateCredentials(candidate);
      return true;
    });
  }

  /** True for valid credentials, false for rejected ones; throws when the cloud is unreachable. */
  private async checkLogin(client: SyncClient): Promise<boolean> {
    try {
      await client.login();
      return true;
    } catch (error) {
      if (error instanceof SyncAuthError) {
        return false;
      }
      this.error('Login check failed:', error instanceof Error ? error.message : error);
      throw new Error(this.homey.__('pair.unreachable'), { cause: error });
    }
  }
}
