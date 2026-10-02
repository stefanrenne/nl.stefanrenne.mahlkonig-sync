import type { RawDevice } from './SyncClient.mjs';

/** "Mahlkönig E64 WS" for the cloud's "E64WS"; other models keep their cloud type. */
export function deviceName(device: Pick<RawDevice, 'type'>): string {
  const model = device.type === 'E64WS' ? 'E64 WS' : device.type ?? 'grinder';
  return `Mahlkönig ${model}`;
}
