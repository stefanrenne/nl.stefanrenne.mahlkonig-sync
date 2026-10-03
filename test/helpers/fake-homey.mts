import { readFileSync } from 'node:fs'
import { vi } from 'vitest'

type Args = Record<string, unknown>
type RunListener = (args: Args, state?: Args) => unknown

// The generated manifest, for tests that need the real cards.
export const manifest = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8'))

/** Records everything the app or a device registers on a flow card. */
export class FakeCard {
  id: string
  runListener?: RunListener
  trigger = vi.fn(async (...args: unknown[]) => undefined)

  constructor(id: string) {
    this.id = id
  }

  registerRunListener(listener: RunListener) {
    this.runListener = listener
    return this
  }

  async run(args: Args, state?: Args) {
    if (this.runListener === undefined) {
      throw new Error(`No run listener registered for ${this.id}`)
    }
    return this.runListener(args, state)
  }

  /** The tokens of every trigger call, in order. */
  tokens() {
    return this.trigger.mock.calls.map((call) => call[1] as Args)
  }
}

export function createFakeHomey() {
  const cards = new Map<string, FakeCard>()
  const card = (id: string): FakeCard => {
    let result = cards.get(id)
    if (result === undefined) {
      result = new FakeCard(id)
      cards.set(id, result)
    }
    return result
  }

  // Devices per driver id, for code that looks devices up through homey.drivers.
  const devices = new Map<string, unknown[]>()
  const widgetAutocomplete = new Map<string, (query: string) => unknown>()

  const homey = {
    manifest,
    flow: { getConditionCard: card, getDeviceTriggerCard: card },
    api: { realtime: vi.fn((_event: string, _data: unknown) => undefined) },
    drivers: { getDriver: (id: string) => ({ getDevices: () => devices.get(id) ?? [] }) },
    dashboards: {
      getWidget: (_id: string) => ({
        registerSettingAutocompleteListener: (name: string, listener: (query: string) => unknown) => {
          widgetAutocomplete.set(name, listener)
        },
      }),
    },
    // Returns the key plus its placeholders, so tests assert on keys rather than English text.
    __: (key: string, tokens?: Record<string, string>) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key),
    i18n: { getLanguage: () => 'en' },
    clock: { getTimezone: () => 'Europe/Amsterdam' },
    // The device schedules its own polls; tests call tick()/poll() directly.
    setTimeout: vi.fn((_callback: () => void, _ms: number) => ({}) as NodeJS.Timeout),
    clearTimeout: vi.fn(),
  }

  return { homey, card, cards, devices, widgetAutocomplete }
}

export type FakeHomey = ReturnType<typeof createFakeHomey>['homey']
