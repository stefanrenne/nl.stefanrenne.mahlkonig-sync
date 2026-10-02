import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncApiError, SyncAuthError, type RawBrewEvent, type RawGrindEvent, type SyncClient } from '../lib/SyncClient.mjs'
import { createFakeHomey, manifest, type FakeCard, type FakeHomey } from './helpers/fake-homey.mjs'

const { default: E64WSDevice } = await import('../drivers/e64ws/device.mjs')

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const [rawShot, rawPurge] = fixture('grind-events.json') as RawGrindEvent[]

const DRIVER_CAPABILITIES: string[] = manifest.drivers.find((driver: { id: string }) => driver.id === 'e64ws').capabilities
const MINUTE = 60_000

function createFakeClient() {
  return {
    findGrindEvents: vi.fn(async (..._args: unknown[]): Promise<RawGrindEvent[]> => []),
    findBrewEvents: vi.fn(async (..._args: unknown[]): Promise<RawBrewEvent[]> => []),
    getDevice: vi.fn(async (..._args: unknown[]) => fixture('device.json')),
    getScaleBinding: vi.fn(async (..._args: unknown[]) => fixture('brewer-binding.json').items[0]),
  }
}
type FakeClient = ReturnType<typeof createFakeClient>

type DeviceMethods = Pick<InstanceType<typeof E64WSDevice>,
  'onInit' | 'tick' | 'poll' | 'lastGrindWithin' | 'onSettings' | 'updateCredentials' | 'onDeleted'>
type Harness = DeviceMethods & {
  capabilities: string[]
  capabilityValues: Map<string, unknown>
  settings: Record<string, unknown>
  store: Record<string, unknown>
  available: boolean
  unavailableMessage: string | undefined
  errors: unknown[][]
  clients: unknown[]
}

let homey: FakeHomey
let card: (id: string) => FakeCard
let client: FakeClient

function createDevice(store: Record<string, unknown> = { email: 'user@example.com', password: 'secret' }): Harness {
  class TestDevice extends E64WSDevice {
    clients: unknown[] = []

    createClient(credentials: unknown) {
      this.clients.push(credentials)
      return client as unknown as SyncClient
    }
  }
  const Constructor = TestDevice as unknown as new (homey: FakeHomey, options: object) => Harness
  return new Constructor(homey, {
    data: { id: 'GRINDER-1' },
    store,
    capabilities: DRIVER_CAPABILITIES,
    settings: { poll_interval: 2, purge_threshold: 5 },
  })
}

/** A grind event shaped like the cloud's, `minutesAgo` before now. */
function grindEvent(uuid: string, minutesAgo: number, weightMg: number, triggerMode = 'PortafilterDetection'): RawGrindEvent {
  const at = new Date(Date.now() - minutesAgo * MINUTE).toISOString()
  return {
    ...rawShot,
    eventUuid: uuid,
    deviceDate: at,
    cloudDate: at,
    payload: { ...rawShot.payload, weightActual: weightMg, triggerMode },
  }
}

function brewEvent(uuid: string, minutesAgo: number, massMg = 40_000, durationMs = 27_500): RawBrewEvent {
  const at = new Date(Date.now() - minutesAgo * MINUTE).toISOString()
  return { eventUuid: uuid, deviceDate: at, cloudDate: at, payload: { mass: massMg, duration: durationMs, stopType: 'AutoTimerFlow' } }
}

const lastDelay = () => homey.setTimeout.mock.calls.at(-1)?.[1]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-02T07:30:00Z'))
  ;({ homey, card } = createFakeHomey())
  client = createFakeClient()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('initialisation', () => {
  it('creates the client from the stored credentials and polls right away', async () => {
    const device = createDevice()

    await device.onInit()

    expect(device.clients).toEqual([{ email: 'user@example.com', password: 'secret' }])
    expect(lastDelay()).toBe(0)
  })
})

describe('first poll (baseline)', () => {
  it('shows the last real grind and fires nothing', async () => {
    client.findGrindEvents.mockResolvedValue([rawShot, rawPurge])
    const device = createDevice()
    await device.onInit()

    await device.poll()

    expect(card('grind_completed').trigger).not.toHaveBeenCalled()
    expect(Object.fromEntries(device.capabilityValues)).toMatchObject({
      dose_weight: 20,
      grind_setting: 139,
      grind_time: 7.9,
      dose_target: 20,
      grind_setting_target: 140,
      brew_time_target: 25,
      recipe_mode: 'Gbw',
      last_grind: '10/2/26, 8:59 AM',
    })
  })

  it('shows the grinder status and the paired scale', async () => {
    const device = createDevice()
    await device.onInit()

    await device.poll()

    expect(Object.fromEntries(device.capabilityValues)).toMatchObject({
      standby: true,
      measure_temperature: 34,
      disc_usage: 4,
      disc_health: 0,
    })
    expect(device.capabilities).toEqual(expect.arrayContaining(['yield_weight', 'shot_time', 'brew_ratio']))
    expect(device.settings).toMatchObject({
      model: 'Mahlkönig E64 WS',
      serial: 'SERIAL-1',
      firmware: 'V01.16-24 / V01.11',
      scale: 'SCALE-1',
    })
  })

  it('adds no scale capabilities without a paired scale', async () => {
    client.getScaleBinding.mockResolvedValue(null)
    const device = createDevice()
    await device.onInit()

    await device.poll()

    expect(device.capabilities).not.toContain('yield_weight')
    expect(device.settings.scale).toBe('settings.noScale')
    expect(client.findBrewEvents).not.toHaveBeenCalled()
  })

  it('asks for the last 24 hours of grinds of this grinder', async () => {
    const device = createDevice()
    await device.onInit()

    await device.poll()

    const [grinderId, from, to] = client.findGrindEvents.mock.calls[0] as [string, Date, Date]
    expect(grinderId).toBe('GRINDER-1')
    expect(from.toISOString()).toBe('2026-10-01T07:30:00.000Z')
    expect(to.toISOString()).toBe('2026-10-02T07:35:00.000Z')
  })
})

describe('Grind completed', () => {
  async function pollTwice(device: Harness, second: RawGrindEvent[]) {
    client.findGrindEvents.mockResolvedValueOnce([grindEvent('old', 120, 18_000)])
    await device.poll()
    client.findGrindEvents.mockResolvedValueOnce(second)
    await device.poll()
  }

  it('fires once per new grind, purges included, with the purge flag and how it was started', async () => {
    const device = createDevice()
    await device.onInit()

    await pollTwice(device, [grindEvent('shot', 1, 19_976), grindEvent('purge', 2, 1_637, 'StartButton')])

    expect(card('grind_completed').tokens()).toEqual([
      { dose: 1.6, grind_setting: 139, grind_time: 7.9, started_via: 'StartButton', is_purge: true },
      { dose: 20, grind_setting: 139, grind_time: 7.9, started_via: 'PortafilterDetection', is_purge: false },
    ])
  })

  it('doesn\'t fire again for grinds it already reported', async () => {
    const device = createDevice()
    await device.onInit()
    await pollTwice(device, [grindEvent('shot', 1, 19_976)])

    client.findGrindEvents.mockResolvedValueOnce([grindEvent('shot', 1, 19_976)])
    await device.poll()

    expect(card('grind_completed').trigger).toHaveBeenCalledTimes(1)
  })

  it('keeps showing the real grind when a purge follows it', async () => {
    const device = createDevice()
    await device.onInit()

    await pollTwice(device, [grindEvent('purge', 1, 1_200, 'StartButton'), grindEvent('shot', 2, 18_100)])

    expect(device.capabilityValues.get('dose_weight')).toBe(18.1)
  })

  it('follows the purge threshold setting', async () => {
    const device = createDevice()
    device.settings.purge_threshold = 1
    await device.onInit()

    await pollTwice(device, [grindEvent('small', 1, 1_600, 'StartButton')])

    expect(card('grind_completed').tokens()[0]).toMatchObject({ is_purge: false })
    expect(device.capabilityValues.get('dose_weight')).toBe(1.6)
  })

  it('updates the device but fires nothing for grinds older than an hour when first seen', async () => {
    const device = createDevice()
    await device.onInit()

    await pollTwice(device, [grindEvent('late', 61, 18_000)])

    expect(card('grind_completed').trigger).not.toHaveBeenCalled()
  })

  it('remembers what it reported across restarts', async () => {
    const device = createDevice()
    await device.onInit()
    await pollTwice(device, [grindEvent('shot', 1, 19_976)])

    const restarted = createDevice(device.store)
    await restarted.onInit()
    client.findGrindEvents.mockResolvedValueOnce([grindEvent('shot', 1, 19_976)])
    await restarted.poll()

    expect(card('grind_completed').trigger).toHaveBeenCalledTimes(1)
  })

  it('looks back from just before the newest grind it saw', async () => {
    const device = createDevice()
    await device.onInit()
    await pollTwice(device, [grindEvent('shot', 10, 19_976)])

    await device.poll()

    const from = client.findGrindEvents.mock.calls.at(-1)?.[1] as Date
    expect(from.toISOString()).toBe('2026-10-02T07:15:00.000Z')
  })
})

describe('Shot completed', () => {
  it('fires with yield, shot time and the dose and ratio of the grind before it', async () => {
    const device = createDevice()
    await device.onInit()
    client.findBrewEvents.mockResolvedValueOnce([brewEvent('earlier-shot', 300)])
    await device.poll()

    client.findGrindEvents.mockResolvedValueOnce([grindEvent('grind', 3, 18_000)])
    client.findBrewEvents.mockResolvedValueOnce([brewEvent('shot', 1, 36_400, 27_500)])
    await device.poll()

    expect(card('shot_completed').tokens()).toEqual([{ yield: 36.4, shot_time: 27.5, dose: 18, ratio: 2.02 }])
    expect(Object.fromEntries(device.capabilityValues)).toMatchObject({ yield_weight: 36.4, shot_time: 27.5, brew_ratio: 2.02 })
  })

  it('ignores purges and reports dose and ratio 0 without a grind shortly before', async () => {
    const device = createDevice()
    await device.onInit()
    await device.poll()

    client.findGrindEvents.mockResolvedValueOnce([grindEvent('purge', 2, 1_000, 'StartButton')])
    client.findBrewEvents.mockResolvedValueOnce([brewEvent('shot', 1)])
    await device.poll()

    expect(card('shot_completed').tokens()).toEqual([{ yield: 40, shot_time: 27.5, dose: 0, ratio: 0 }])
  })

  it('doesn\'t fire for the shots that were there on the first poll', async () => {
    client.findBrewEvents.mockResolvedValue([brewEvent('old', 5)])
    const device = createDevice()
    await device.onInit()

    await device.poll()
    await device.poll()

    expect(card('shot_completed').trigger).not.toHaveBeenCalled()
  })
})

describe('errors and recovery', () => {
  it('marks the device unavailable and backs off exponentially, up to 30 minutes', async () => {
    client.findGrindEvents.mockRejectedValue(new SyncApiError('Could not reach Mahlkönig Sync (fetch failed)'))
    const device = createDevice()
    await device.onInit()

    await device.tick()
    expect(device.available).toBe(false)
    expect(device.unavailableMessage).toBe('errors.unreachable {"message":"Could not reach Mahlkönig Sync (fetch failed)"}')
    expect(lastDelay()).toBe(4 * MINUTE)

    await device.tick()
    expect(lastDelay()).toBe(8 * MINUTE)
    await device.tick()
    await device.tick()
    expect(lastDelay()).toBe(30 * MINUTE)
  })

  it('recovers with setAvailable and the normal interval', async () => {
    client.findGrindEvents.mockRejectedValueOnce(new SyncApiError('down'))
    const device = createDevice()
    await device.onInit()
    await device.tick()

    await device.tick()

    expect(device.available).toBe(true)
    expect(lastDelay()).toBe(2 * MINUTE)
  })

  it('explains rejected credentials', async () => {
    client.findGrindEvents.mockRejectedValue(new SyncAuthError())
    const device = createDevice()
    await device.onInit()

    await device.tick()

    expect(device.unavailableMessage).toBe('errors.auth')
  })

  it('keeps detecting grinds when the status refresh fails', async () => {
    client.getDevice.mockRejectedValue(new SyncApiError('HTTP 500'))
    client.findGrindEvents.mockResolvedValue([rawShot])
    const device = createDevice()
    await device.onInit()

    await device.tick()

    expect(device.available).toBe(true)
    expect(device.capabilityValues.get('dose_weight')).toBe(20)
  })

  it('never logs the password', async () => {
    client.findGrindEvents.mockRejectedValue(new SyncAuthError())
    const device = createDevice()
    await device.onInit()

    await device.tick()

    expect(JSON.stringify(device.errors)).not.toContain('secret')
  })
})

describe('settings and credentials', () => {
  it('reschedules when the poll interval changes', async () => {
    const device = createDevice()
    await device.onInit()

    await device.onSettings({ newSettings: { poll_interval: 5 }, changedKeys: ['poll_interval'] })

    expect(lastDelay()).toBe(5 * MINUTE)
  })

  it('stores repaired credentials and polls with a new client', async () => {
    const device = createDevice()
    await device.onInit()

    await device.updateCredentials({ email: 'new@example.com', password: 'new-secret' })

    expect(device.store).toMatchObject({ email: 'new@example.com', password: 'new-secret' })
    expect(device.clients.at(-1)).toEqual({ email: 'new@example.com', password: 'new-secret' })
    expect(lastDelay()).toBe(0)
  })

  it('stops polling when deleted', async () => {
    const device = createDevice()
    await device.onInit()
    device.onDeleted()
    const calls = homey.setTimeout.mock.calls.length

    await device.tick()

    expect(homey.setTimeout.mock.calls.length).toBe(calls)
  })
})

describe('Last grind was less than … minutes ago', () => {
  it('compares the last real grind with now and ignores purges', async () => {
    client.findGrindEvents.mockResolvedValueOnce([grindEvent('shot', 10, 18_000), grindEvent('purge', 1, 1_000, 'StartButton')])
    const device = createDevice()
    await device.onInit()
    await device.poll()

    expect(device.lastGrindWithin(11)).toBe(true)
    expect(device.lastGrindWithin(10)).toBe(false)
    expect(device.lastGrindWithin(5)).toBe(false)
  })

  it('is false before any grind was seen', async () => {
    const device = createDevice()
    await device.onInit()

    expect(device.lastGrindWithin(60)).toBe(false)
  })
})
