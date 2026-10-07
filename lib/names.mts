import type { RawDevice, RawScale } from './SyncClient.mjs';

/** "Mahlkönig E64 WS" for the cloud's "E64WS"; other models keep their cloud type. */
export function deviceName(device: Pick<RawDevice, 'type'>): string {
  const model = device.type === 'E64WS' ? 'E64 WS' : device.type ?? 'grinder';
  return `Mahlkönig ${model}`;
}

/** "Mahlkönig E64 WS (SERIAL)" for the grinder a scale is paired with in Sync, or null when none. */
export function pairedGrinderName(scale: RawScale): string | null {
  const grinder = scale.bindings?.find((binding) => binding.toDevice !== undefined)?.toDevice;
  if (grinder === undefined) {
    return null;
  }
  return grinder.serial ? `${deviceName(grinder)} (${grinder.serial})` : deviceName(grinder);
}
