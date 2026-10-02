import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_URL, SyncApiError, SyncAuthError, SyncClient } from '../lib/SyncClient.mjs'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

interface Recorded {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

type Reply = { status?: number, body?: unknown, text?: string } | Error

/** A fetch stand-in: routes "METHOD /path" (query string ignored) to queued replies and records every request. */
function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const requests: Recorded[] = []
  const queues = new Map(Object.entries(routes).map(([key, reply]) => [key, Array.isArray(reply) ? [...reply] : [reply]]))
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(DEFAULT_BASE_URL, '')
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ method, path, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const queue = queues.get(`${method} ${path.split('?')[0]}`)
    if (queue === undefined || queue.length === 0) {
      throw new Error(`Unexpected request ${method} ${path}`)
    }
    const reply = queue.length > 1 ? queue.shift()! : queue[0]
    if (reply instanceof Error) {
      throw reply
    }
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    return new Response(text, { status: reply.status ?? 200 })
  }
  return { fetch: fetch as typeof globalThis.fetch, requests }
}

const NOW = Date.parse('2026-10-02T07:00:00Z')

// The login response's shape as seen live (docs/sync-api.md, Login); tokens are fake.
const loginResponse = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
  expires_in: 599_222,
  access_expires: '2026-10-02T07:10:00.000Z',
  refresh_expires: '2026-10-10T07:00:00.000Z',
  details: { comp: 10001 },
  ...overrides,
})

const credentials = { email: 'user@example.com', password: 'secret' }
const client = (routes: Record<string, Reply | Reply[]>, now = () => NOW) => {
  const fake = fakeFetch(routes)
  return { ...fake, client: new SyncClient(credentials, { fetch: fake.fetch, now }) }
}

describe('login', () => {
  it('posts the e-mail as username and keeps the company id', async () => {
    const { client: sync, requests } = client({ 'POST /security-service/auth/token': { body: loginResponse() } })

    await sync.login()

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/security-service/auth/token',
      body: { username: 'user@example.com', password: 'secret' },
    })
    expect(requests[0].headers.authorization).toBeUndefined()
    expect(sync.companyId).toBe(10001)
  })

  it.each([400, 401, 403])('throws SyncAuthError on HTTP %i', async (status) => {
    const { client: sync } = client({ 'POST /security-service/auth/token': { status, body: { code: `${status}` } } })

    await expect(sync.login()).rejects.toBeInstanceOf(SyncAuthError)
  })

  it('throws SyncAuthError when the response has no access token', async () => {
    const { client: sync } = client({ 'POST /security-service/auth/token': { body: { token_type: 'Bearer' } } })

    await expect(sync.login()).rejects.toBeInstanceOf(SyncAuthError)
  })

  it('throws SyncApiError on a server error or a network failure', async () => {
    const { client: down } = client({ 'POST /security-service/auth/token': { status: 503, text: 'Service Unavailable' } })
    await expect(down.login()).rejects.toBeInstanceOf(SyncApiError)

    const { client: offline } = client({ 'POST /security-service/auth/token': new TypeError('fetch failed') })
    await expect(offline.login()).rejects.toThrow(/Could not reach Mahlkönig Sync \(fetch failed\)/)
  })

  it('never puts the password in an error message', async () => {
    const { client: sync } = client({ 'POST /security-service/auth/token': { status: 500, text: 'secret' } })

    const error = await sync.login().catch((caught: Error) => caught)
    expect(String((error as Error).message)).not.toContain('secret')
  })
})

describe('session handling', () => {
  it('sends the access token as a Bearer header', async () => {
    const { client: sync, requests } = client({
      'POST /security-service/auth/token': { body: loginResponse() },
      'POST /mobile-service/stats/event/last-events': { body: fixture('last-events.json') },
    })

    await sync.getLastEvents()

    expect(requests.map((request) => request.path)).toEqual(['/security-service/auth/token', '/mobile-service/stats/event/last-events'])
    expect(requests[1].headers.authorization).toBe('Bearer access-1')
  })

  it('reuses the token until shortly before it expires, then refreshes with the refresh token', async () => {
    let now = NOW
    const { client: sync, requests } = client({
      'POST /security-service/auth/token': { body: loginResponse() },
      'GET /security-service/auth/refresh': { body: loginResponse({ access_token: 'access-2', refresh_token: undefined, refresh_expires: undefined, access_expires: '2026-10-02T07:20:00.000Z' }) },
      'POST /mobile-service/stats/event/last-events': { body: fixture('last-events.json') },
    }, () => now)

    await sync.getLastEvents()
    now = Date.parse('2026-10-02T07:08:00Z') // 2 minutes left: still fine
    await sync.getLastEvents()
    now = Date.parse('2026-10-02T07:09:30Z') // 30 s left: inside the margin
    await sync.getLastEvents()

    const paths = requests.map((request) => `${request.method} ${request.path}`)
    expect(paths.filter((path) => path.includes('auth/token'))).toHaveLength(1)
    const refresh = requests.find((request) => request.path === '/security-service/auth/refresh')
    expect(refresh?.headers.authorization).toBe('Bearer refresh-1')
    expect(requests.at(-1)?.headers.authorization).toBe('Bearer access-2')
  })

  it('keeps the original refresh token, which the refresh response leaves out', async () => {
    let now = NOW
    const { client: sync, requests } = client({
      'POST /security-service/auth/token': { body: loginResponse() },
      'GET /security-service/auth/refresh': [
        { body: { access_token: 'access-2', access_expires: '2026-10-02T07:20:00.000Z' } },
        { body: { access_token: 'access-3', access_expires: '2026-10-02T07:30:00.000Z' } },
      ],
      'POST /mobile-service/stats/event/last-events': { body: fixture('last-events.json') },
    }, () => now)

    await sync.getLastEvents()
    now = Date.parse('2026-10-02T07:09:30Z')
    await sync.getLastEvents()
    now = Date.parse('2026-10-02T07:19:30Z')
    await sync.getLastEvents()

    const refreshes = requests.filter((request) => request.path === '/security-service/auth/refresh')
    expect(refreshes.map((request) => request.headers.authorization)).toEqual(['Bearer refresh-1', 'Bearer refresh-1'])
  })

  it('logs in again when the refresh fails', async () => {
    let now = NOW
    const { client: sync, requests } = client({
      'POST /security-service/auth/token': [
        { body: loginResponse() },
        { body: loginResponse({ access_token: 'access-2', access_expires: '2026-10-02T07:20:00.000Z' }) },
      ],
      'GET /security-service/auth/refresh': { status: 401 },
      'POST /mobile-service/stats/event/last-events': { body: fixture('last-events.json') },
    }, () => now)

    await sync.getLastEvents()
    now = Date.parse('2026-10-02T07:09:30Z')
    await sync.getLastEvents()

    expect(requests.filter((request) => request.path === '/security-service/auth/token')).toHaveLength(2)
    expect(requests.at(-1)?.headers.authorization).toBe('Bearer access-2')
  })

  it('logs in again once and retries when a request returns 401', async () => {
    const { client: sync, requests } = client({
      'POST /security-service/auth/token': [
        { body: loginResponse() },
        { body: loginResponse({ access_token: 'access-2' }) },
      ],
      'POST /mobile-service/stats/event/last-events': [{ status: 401 }, { body: fixture('last-events.json') }],
    })

    const events = await sync.getLastEvents()

    expect(events.lastGrind?.eventUuid).toBe('00000000-0000-4000-8000-000000000002')
    expect(requests.filter((request) => request.path === '/security-service/auth/token')).toHaveLength(2)
    expect(requests.at(-1)?.headers.authorization).toBe('Bearer access-2')
  })

  it('gives up with SyncApiError when the retry is refused too', async () => {
    const { client: sync } = client({
      'POST /security-service/auth/token': { body: loginResponse() },
      'POST /mobile-service/stats/event/last-events': { status: 403 },
    })

    await expect(sync.getLastEvents()).rejects.toMatchObject({ name: 'SyncApiError', status: 403 })
  })

  it('shares one login between concurrent requests', async () => {
    const { client: sync, requests } = client({
      'POST /security-service/auth/token': { body: loginResponse() },
      'POST /mobile-service/stats/event/last-events': { body: fixture('last-events.json') },
    })

    await Promise.all([sync.getLastEvents(), sync.getLastEvents(), sync.getLastEvents()])

    expect(requests.filter((request) => request.path === '/security-service/auth/token')).toHaveLength(1)
  })
})

describe('data endpoints', () => {
  const loggedIn = (routes: Record<string, Reply | Reply[]>) =>
    client({ 'POST /security-service/auth/token': { body: loginResponse() }, ...routes })

  it('getLastEvents returns the newest grind and brew, or null for each', async () => {
    const { client: sync, requests } = loggedIn({ 'POST /mobile-service/stats/event/last-events': [{ body: fixture('last-events.json') }, { body: {} }] })

    const events = await sync.getLastEvents()
    expect(events.lastGrind?.payload?.weightActual).toBe(19976)
    expect(events.lastBrew?.payload?.mass).toBe(1000)
    expect(requests[1].body).toEqual({ limitToCurrentDevice: true })

    expect(await sync.getLastEvents()).toEqual({ lastGrind: null, lastBrew: null })
  })

  it('findGrindEvents sends the app\'s query shape for one grinder', async () => {
    const { client: sync, requests } = loggedIn({ 'POST /mobile-service/grind-event/find': { body: fixture('grind-events.json') } })

    const events = await sync.findGrindEvents('GRINDER-1', new Date('2026-10-01T22:00:00Z'), new Date('2026-10-02T21:59:59.999Z'))

    expect(events).toHaveLength(2)
    expect(requests[1].body).toEqual({
      deviceDateRange: { from: '2026-10-01T22:00:00.000Z', to: '2026-10-02T21:59:59.999Z' },
      orderBy: 'deviceDate',
      orderDir: 'DESC',
      loadDevice: false,
      deviceIds: ['GRINDER-1'],
      storeIds2: null,
      storeIds: null,
      regionIds: null,
      companyIds: null,
    })
  })

  it('findBrewEvents queries the brew endpoint and treats an empty body as no events', async () => {
    const { client: sync, requests } = loggedIn({ 'POST /mobile-service/device-event/brew-event/find': { text: '' } })

    expect(await sync.findBrewEvents('SCALE-1', new Date(NOW - 1000), new Date(NOW))).toEqual([])
    expect((requests[1].body as { deviceIds: string[] }).deviceIds).toEqual(['SCALE-1'])
  })

  it('getDevice asks for the device by key', async () => {
    const { client: sync, requests } = loggedIn({ 'GET /mobile-service/device/': { body: fixture('device.json') } })

    const device = await sync.getDevice('GRINDER-1')

    expect(requests[1].path).toBe('/mobile-service/device/?key=GRINDER-1')
    expect(device.status?.status?.motorTemperature).toBe(34)
  })

  it('getScaleBinding returns the paired scale, or null', async () => {
    const { client: sync, requests } = loggedIn({
      'POST /mobile-service/brewer-binding/query': [{ body: fixture('brewer-binding.json') }, { body: { items: [] } }],
    })

    expect((await sync.getScaleBinding('GRINDER-1'))?.brewerId).toBe('SCALE-1')
    expect(requests[1].body).toMatchObject({ grinderId: 'GRINDER-1', loadDevice: true })
    expect(await sync.getScaleBinding('GRINDER-1')).toBeNull()
  })

  it('listGrinders lists the company\'s grinders without scales', async () => {
    const { client: sync, requests } = loggedIn({
      'POST /admin-service/device/query': { body: { items: [{ deviceId: 'GRINDER-1', type: 'E64WS' }, { deviceId: 'SCALE-1', type: 'scale' }] } },
    })

    expect(await sync.listGrinders()).toEqual([{ deviceId: 'GRINDER-1', type: 'E64WS' }])
    expect(requests[1].body).toMatchObject({ companyId: 10001 })
  })

  it('listGrinders falls back to the device of the newest grind when the list is refused', async () => {
    const { client: sync } = loggedIn({
      'POST /admin-service/device/query': [{ status: 403 }, { status: 403 }],
      'POST /mobile-service/stats/event/last-events': { body: fixture('last-events.json') },
    })

    const grinders = await sync.listGrinders()

    expect(grinders.map((grinder) => grinder.deviceId)).toEqual(['GRINDER-1'])
  })

  it('listScales asks for the account\'s scales like the official app', async () => {
    const { client: sync, requests } = loggedIn({ 'POST /mobile-service/device-union/query': { body: fixture('scales.json') } })

    const scales = await sync.listScales()

    expect(scales.map((scale) => scale.deviceId)).toEqual(['SCALE-1'])
    expect(scales[0].bindings?.[0].toDevice?.serial).toBe('SERIAL-1')
    expect(requests[1].body).toMatchObject({ deviceClasses: ['SCALE'], loadBindings: true, excludeTypes: ['xenia'] })
  })

  it('listScales falls back to the scales paired with the company\'s grinders', async () => {
    const { client: sync, requests } = loggedIn({
      'POST /mobile-service/device-union/query': [{ status: 403 }, { status: 403 }],
      'POST /admin-service/device/query': {
        body: {
          items: [{
            deviceId: 'GRINDER-1',
            type: 'E64WS',
            serial: 'SERIAL-1',
            bindings: [{ grinderId: 'GRINDER-1', brewerId: 'SCALE-1', brewer: { brewerId: 'SCALE-1', serial: 'SCALE-1', type: 'scale' } }],
          }],
        },
      },
    })

    const scales = await sync.listScales()

    expect(scales).toEqual([{
      deviceId: 'SCALE-1',
      serial: 'SCALE-1',
      type: 'scale',
      bindings: [{ toDeviceId: 'GRINDER-1', toDevice: expect.objectContaining({ deviceId: 'GRINDER-1', serial: 'SERIAL-1' }) }],
    }])
    expect(requests.at(-1)?.body).toMatchObject({ companyId: 10001, loadBindings: true })
  })

  it('throws SyncApiError for an unreadable response', async () => {
    const { client: sync } = loggedIn({ 'POST /mobile-service/stats/event/last-events': { text: '<html>' } })

    await expect(sync.getLastEvents()).rejects.toThrow(/unreadable response/)
  })
})
