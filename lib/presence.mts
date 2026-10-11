// Is a grinder or Sync Scale on the local network? Both answer on TCP port 80: the grinder
// accepts the connection, the scale refuses it. Either answer means the device is there; no answer
// (time-out, unreachable) means it's off or off the network. A Homey app can't ping (no ICMP), so
// this is how it checks. See docs/device.md, "Online".
import { promises as dns } from 'node:dns';
import net from 'node:net';

export const PRESENCE_PORT = 80;
export const PRESENCE_TIMEOUT_MS = 3_000;

/** The DHCP host name every Sync Scale registers; routers like UniFi publish it in their DNS. */
export const SCALE_HOST_NAMES = ['SyncScale', 'SyncScale.localdomain'];

/** The mDNS `_workstation._tcp` instance name of a grinder starts with this, followed by its device id. */
export const GRINDER_MDNS_PREFIX = 'hemrohsg';

/** The grinder's mDNS host name (`hemrohsg<deviceId>.local`), a fallback when discovery finds nothing. */
export function grinderHostNames(deviceId: string): string[] {
  return [`${GRINDER_MDNS_PREFIX}${deviceId}.local`];
}

type Connect = (options: { host: string; port: number; timeout: number }) => net.Socket;

/** True when the host answers on the port (connection accepted or refused), false otherwise. */
export function probeHost(host: string, port = PRESENCE_PORT, timeoutMs = PRESENCE_TIMEOUT_MS, connect: Connect = net.connect): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const finish = (online: boolean) => {
      socket.destroy();
      resolve(online);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'));
  });
}

type Lookup = (hostname: string, options: { family: 4 }) => Promise<{ address: string }>;

/** The IPv4 address of the first name that resolves, or null. */
export async function lookupFirst(names: string[], lookup: Lookup = dns.lookup as unknown as Lookup): Promise<string | null> {
  for (const name of names) {
    try {
      const { address } = await lookup(name, { family: 4 });
      if (address) {
        return address;
      }
    } catch {
      // Not known under this name: try the next one.
    }
  }
  return null;
}

/** True when an mDNS result (name, host or full name) is the grinder with this device id. */
export function isGrinderAnnouncement(result: { name?: string; host?: string; fullname?: string }, deviceId: string): boolean {
  const wanted = `${GRINDER_MDNS_PREFIX}${deviceId}`.toLowerCase();
  // The id must end there ("hemrohsg39C8DC [mac]", "….local"), so id 1 never matches id 10.
  return [result.name, result.host, result.fullname].some((value) => {
    if (typeof value !== 'string' || !value.toLowerCase().startsWith(wanted)) {
      return false;
    }
    return !/[a-z0-9]/i.test(value.charAt(wanted.length));
  });
}
