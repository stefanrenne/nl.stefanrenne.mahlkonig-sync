import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncApiError, SyncAuthError, type RawBrewEvent, type RawScale, type SyncClient } from '../lib/SyncClient.mjs'
import { createFakeHomey, manifest, type FakeCard, type FakeHomey } from './helpers/fake-homey.mjs'

const { default: SyncScaleDevice } = await import('../drivers/sync-scale/device.mjs')
const { default: SyncScaleDriver } = await import('../drivers/sync-scale/driver.mjs')

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const SCALE_CAPABILITIES: string[] = manifest.drivers.find((driver: { id: string }) => driver.id === 'sync-scale').capabilities
const MINUTE = 60_000

let homey: FakeHomey
let card: (id: string) => FakeCard

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-02T07:30:00Z'))
  ;({ homey, card } = createFakeHomey())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Sync Scale device', () => {
  type Harness = Pick<InstanceType<typeof SyncScaleDevice>, 'onInit' | 'tick' | 'poll'> & {
    capabilities: string[]
    capabilityValues: Map<string, unknown>
    store: Record<string, unknown>
    available: boolean
    unavailableMessage: string | undefined
  }

  let client: { findBrewEvents: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<RawBrewEvent[]>>> }

  function createDevice(store: Record<string, unknown> = { email: 'user@example.com', password: 'secret' }): Harness {
    class TestDevice extends SyncScaleDevice {
      createClient() {
        return client as unknown as SyncClient
      }
    }
    const Constructor = TestDevice as unknown as new (homey: FakeHomey, options: object) => Harness
    return new Constructor(homey, { data: { id: 'SCALE-1' }, store, capabilities: SCALE_CAPABILITIES, settings: { poll_interval: 2 } })
  }

  function brewEvent(uuid: string, minutesAgo: number, massMg = 36_400, durationMs = 27_500): RawBrewEvent {
    const at = new Date(Date.now() - minutesAgo * MINUTE).toISOString()
    return { eventUuid: uuid, deviceDate: at, cloudDate: at, payload: { mass: massMg, duration: durationMs, stopType: 'AutoTimerFlow' } }
  }

  beforeEach(() => {
    client = { findBrewEvents: vi.fn(async () => []) }
  })

  it('has yield, shot time and last shot, and no dose or ratio', () => {
    expect(SCALE_CAPABILITIES).toEqual(['yield_weight', 'shot_time', 'last_shot'])
  })

  it('shows the last shot on the first poll without firing', async () => {
    client.findBrewEvents.mockResolvedValue([brewEvent('old', 30)])
    const device = createDevice()
    await device.onInit()

    await device.poll()

    expect(card('scale_shot_completed').trigger).not.toHaveBeenCalled()
    expect(Object.fromEntries(device.capabilityValues)).toEqual({
      yield_weight: 36.4,
      shot_time: 27.5,
      last_shot: '10/2/26, 9:00 AM',
    })
  })

  it('asks for the last 24 hours of shots of this scale', async () => {
    const device = createDevice()
    await device.onInit()

    await device.poll()

    const [scaleId, from, to] = client.findBrewEvents.mock.calls[0] as [string, Date, Date]
    expect(scaleId).toBe('SCALE-1')
    expect(from.toISOString()).toBe('2026-10-01T07:30:00.000Z')
    expect(to.toISOString()).toBe('2026-10-02T07:35:00.000Z')
  })

  it('fires "Shot completed" once per new shot, oldest first, with yield and shot time', async () => {
    const device = createDevice()
    await device.onInit()
    await device.poll()

    client.findBrewEvents.mockResolvedValueOnce([brewEvent('second', 1, 40_000, 30_000), brewEvent('first', 3)])
    await device.poll()
    client.findBrewEvents.mockResolvedValueOnce([brewEvent('second', 1, 40_000, 30_000), brewEvent('first', 3)])
    await device.poll()

    expect(card('scale_shot_completed').tokens()).toEqual([
      { yield: 36.4, shot_time: 27.5 },
      { yield: 40, shot_time: 30 },
    ])
    expect(device.capabilityValues.get('yield_weight')).toBe(40)
  })

  it('doesn\'t fire for shots more than an hour old when first seen', async () => {
    const device = createDevice()
    await device.onInit()
    await device.poll()

    client.findBrewEvents.mockResolvedValueOnce([brewEvent('late', 61)])
    await device.poll()

    expect(card('scale_shot_completed').trigger).not.toHaveBeenCalled()
  })

  it('remembers what it reported across restarts', async () => {
    const device = createDevice()
    await device.onInit()
    await device.poll()
    client.findBrewEvents.mockResolvedValueOnce([brewEvent('shot', 1)])
    await device.poll()

    const restarted = createDevice(device.store)
    await restarted.onInit()
    client.findBrewEvents.mockResolvedValueOnce([brewEvent('shot', 1)])
    await restarted.poll()

    expect(card('scale_shot_completed').trigger).toHaveBeenCalledTimes(1)
  })

  it('reads the whole last 24 hours on every poll', async () => {
    client.findBrewEvents.mockResolvedValueOnce([brewEvent('shot', 10)])
    const device = createDevice()
    await device.onInit()
    await device.poll()

    await device.poll()

    const from = client.findBrewEvents.mock.calls.at(-1)?.[1] as Date
    expect(from.toISOString()).toBe('2026-10-01T07:30:00.000Z')
  })

  it('goes unavailable on errors and explains rejected credentials', async () => {
    client.findBrewEvents.mockRejectedValueOnce(new SyncApiError('down')).mockRejectedValueOnce(new SyncAuthError())
    const device = createDevice()
    await device.onInit()

    await device.tick()
    expect(device.unavailableMessage).toBe('errors.unreachable {"message":"down"}')
    await device.tick()
    expect(device.unavailableMessage).toBe('errors.auth')
    await device.tick()
    expect(device.available).toBe(true)
  })
})

describe('Sync Scale pairing', () => {
  type DriverHarness = Pick<InstanceType<typeof SyncScaleDriver>, 'onPair' | 'onRepair'>
  type Handler = (data?: unknown) => Promise<unknown>

  let client: { login: ReturnType<typeof vi.fn>, listScales: ReturnType<typeof vi.fn<() => Promise<RawScale[]>>> }

  function session() {
    const handlers = new Map<string, Handler>()
    return {
      handlers,
      setHandler(event: string, handler: Handler) {
        handlers.set(event, handler)
        return this
      },
      emit(event: string, data?: unknown) {
        return handlers.get(event)!(data)
      },
    }
  }

  function createDriver(): DriverHarness {
    class TestDriver extends SyncScaleDriver {
      createClient() {
        return client as unknown as SyncClient
      }
    }
    return new (TestDriver as unknown as new (homey: FakeHomey) => DriverHarness)(homey)
  }

  beforeEach(() => {
    client = { login: vi.fn(async () => undefined), listScales: vi.fn(async () => fixture('scales.json').items) }
  })

  it('lists the account\'s scales with their serial and paired grinder', async () => {
    const pairing = session()
    await createDriver().onPair(pairing as unknown as Parameters<DriverHarness['onPair']>[0])

    expect(await pairing.emit('login', { username: 'user@example.com', password: 'secret' })).toBe(true)
    expect(await pairing.emit('list_devices')).toEqual([{
      name: 'Sync Scale',
      data: { id: 'SCALE-1' },
      settings: { serial: 'SCALE-1', grinder: 'Mahlkönig E64 WS (SERIAL-1)' },
      store: { email: 'user@example.com', password: 'secret' },
    }])
  })

  it('shows when a scale isn\'t paired with a grinder', async () => {
    client.listScales.mockResolvedValue([{ deviceId: 'SCALE-2', serial: 'S2', type: 'scale', bindings: [] }])
    const pairing = session()
    await createDriver().onPair(pairing as unknown as Parameters<DriverHarness['onPair']>[0])
    await pairing.emit('login', { username: 'user@example.com', password: 'secret' })

    expect(await pairing.emit('list_devices')).toMatchObject([{ settings: { grinder: 'settings.noGrinder' } }])
  })

  it('says so when the account has no scale', async () => {
    client.listScales.mockResolvedValue([])
    const pairing = session()
    await createDriver().onPair(pairing as unknown as Parameters<DriverHarness['onPair']>[0])
    await pairing.emit('login', { username: 'user@example.com', password: 'secret' })

    await expect(pairing.emit('list_devices')).rejects.toThrow('pair.noScales')
  })

  it('repairs only a scale that belongs to the account', async () => {
    const device = { getData: () => ({ id: 'SCALE-1' }), updateCredentials: vi.fn(async () => undefined) }
    const repair = session()
    await createDriver().onRepair(
      repair as unknown as Parameters<DriverHarness['onRepair']>[0],
      device as unknown as Parameters<DriverHarness['onRepair']>[1],
    )

    expect(await repair.emit('login', { username: 'user@example.com', password: 'new' })).toBe(true)
    expect(device.updateCredentials).toHaveBeenCalledWith({ email: 'user@example.com', password: 'new' })

    client.listScales.mockResolvedValue([{ deviceId: 'OTHER', type: 'scale' }])
    await expect(repair.emit('login', { username: 'other@example.com', password: 'x' })).rejects.toThrow('pair.wrongAccount')
  })
})
