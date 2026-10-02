import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncApiError, SyncAuthError, type RawDevice, type SyncClient, type SyncCredentials } from '../lib/SyncClient.mjs'
import { createFakeHomey, type FakeCard, type FakeHomey } from './helpers/fake-homey.mjs'

const { default: E64WSDriver, deviceName } = await import('../drivers/e64ws/driver.mjs')

type Handler = (data?: unknown) => Promise<unknown>

class FakePairSession {
  handlers = new Map<string, Handler>()

  setHandler(event: string, handler: Handler) {
    this.handlers.set(event, handler)
    return this
  }

  emit(event: string, data?: unknown) {
    const handler = this.handlers.get(event)
    if (handler === undefined) {
      throw new Error(`No handler for ${event}`)
    }
    return handler(data)
  }
}

function createFakeClient() {
  return {
    login: vi.fn(async () => undefined),
    listGrinders: vi.fn(async (): Promise<RawDevice[]> => [{ deviceId: 'GRINDER-1', type: 'E64WS', serial: 'SERIAL-1' }]),
  }
}

type DriverHarness = Pick<InstanceType<typeof E64WSDriver>, 'onInit' | 'onPair' | 'onRepair'> & { credentials: SyncCredentials[] }

let homey: FakeHomey
let card: (id: string) => FakeCard
let client: ReturnType<typeof createFakeClient>

function createDriver(): DriverHarness {
  class TestDriver extends E64WSDriver {
    credentials: SyncCredentials[] = []

    createClient(credentials: SyncCredentials) {
      this.credentials.push(credentials)
      return client as unknown as SyncClient
    }
  }
  const Constructor = TestDriver as unknown as new (homey: FakeHomey) => DriverHarness
  return new Constructor(homey)
}

const pair = async (driver: DriverHarness) => {
  const session = new FakePairSession()
  await driver.onPair(session as unknown as Parameters<DriverHarness['onPair']>[0])
  return session
}

beforeEach(() => {
  ;({ homey, card } = createFakeHomey())
  client = createFakeClient()
})

describe('pairing', () => {
  it('validates the credentials by logging in, then lists the grinders with the credentials in the store', async () => {
    const driver = createDriver()
    const session = await pair(driver)

    expect(await session.emit('login', { username: ' user@example.com ', password: 'secret' })).toBe(true)
    expect(client.login).toHaveBeenCalledTimes(1)
    expect(driver.credentials).toEqual([{ email: 'user@example.com', password: 'secret' }])

    expect(await session.emit('list_devices')).toEqual([{
      name: 'Mahlkönig E64 WS',
      data: { id: 'GRINDER-1' },
      store: { email: 'user@example.com', password: 'secret' },
    }])
  })

  it('reports rejected credentials as a failed login', async () => {
    client.login.mockRejectedValue(new SyncAuthError())
    const session = await pair(createDriver())

    expect(await session.emit('login', { username: 'user@example.com', password: 'wrong' })).toBe(false)
  })

  it('explains an unreachable cloud instead of blaming the credentials', async () => {
    client.login.mockRejectedValue(new SyncApiError('Could not reach Mahlkönig Sync (fetch failed)'))
    const session = await pair(createDriver())

    await expect(session.emit('login', { username: 'user@example.com', password: 'secret' })).rejects.toThrow('pair.unreachable')
  })

  it('says so when the account has no grinder', async () => {
    client.listGrinders.mockResolvedValue([])
    const session = await pair(createDriver())
    await session.emit('login', { username: 'user@example.com', password: 'secret' })

    await expect(session.emit('list_devices')).rejects.toThrow('pair.noGrinders')
  })

  it('refuses to list devices before a successful login', async () => {
    const session = await pair(createDriver())

    await expect(session.emit('list_devices')).rejects.toThrow('pair.unreachable')
  })
})

describe('repair', () => {
  function fakeDevice(id = 'GRINDER-1') {
    return { getData: () => ({ id }), updateCredentials: vi.fn(async (_credentials: SyncCredentials) => undefined) }
  }

  async function repair(device: ReturnType<typeof fakeDevice>) {
    const session = new FakePairSession()
    await createDriver().onRepair(
      session as unknown as Parameters<DriverHarness['onRepair']>[0],
      device as unknown as Parameters<DriverHarness['onRepair']>[1],
    )
    return session
  }

  it('updates the device\'s credentials after a successful login', async () => {
    const device = fakeDevice()
    const session = await repair(device)

    expect(await session.emit('login', { username: 'user@example.com', password: 'new-secret' })).toBe(true)
    expect(device.updateCredentials).toHaveBeenCalledWith({ email: 'user@example.com', password: 'new-secret' })
  })

  it('refuses an account that doesn\'t own this grinder', async () => {
    const device = fakeDevice('OTHER-GRINDER')
    const session = await repair(device)

    await expect(session.emit('login', { username: 'other@example.com', password: 'secret' })).rejects.toThrow('pair.wrongAccount')
    expect(device.updateCredentials).not.toHaveBeenCalled()
  })

  it('reports rejected credentials as a failed login', async () => {
    client.login.mockRejectedValue(new SyncAuthError())
    const device = fakeDevice()
    const session = await repair(device)

    expect(await session.emit('login', { username: 'user@example.com', password: 'wrong' })).toBe(false)
    expect(device.updateCredentials).not.toHaveBeenCalled()
  })
})

describe('condition card', () => {
  it('asks the device', async () => {
    await createDriver().onInit()
    const device = { lastGrindWithin: vi.fn((minutes: number) => minutes > 5) }

    expect(await card('last_grind_within').run({ device, minutes: 10 })).toBe(true)
    expect(await card('last_grind_within').run({ device, minutes: 3 })).toBe(false)
    expect(device.lastGrindWithin).toHaveBeenCalledWith(10)
  })
})

describe('deviceName', () => {
  it('spells the E64 WS like Mahlkönig does and keeps other models as the cloud names them', () => {
    expect(deviceName({ type: 'E64WS' })).toBe('Mahlkönig E64 WS')
    expect(deviceName({ type: 'E65WGbS' })).toBe('Mahlkönig E65WGbS')
    expect(deviceName({})).toBe('Mahlkönig grinder')
  })
})
