import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeHomey, type FakeHomey } from './helpers/fake-homey.mjs'

const { default: widgetApi } = await import('../widgets/espresso/api.mjs')
const { default: MahlkoenigSyncApp } = await import('../app.mjs')

type ApiRequest = Parameters<typeof widgetApi.getTimeline>[0]

let homey: FakeHomey
let devices: Map<string, unknown[]>
let widgetAutocomplete: Map<string, (query: string) => unknown>

function fakeGrinder(id: string, name: string) {
  return {
    getData: () => ({ id }),
    getName: () => name,
    widgetTimeline: vi.fn((limit: number) => [{ id, limit }]),
  }
}

beforeEach(() => {
  ;({ homey, devices, widgetAutocomplete } = createFakeHomey())
})

describe('widget API getTimeline', () => {
  const request = (query: Record<string, string>) => ({ homey, query }) as unknown as ApiRequest

  it('returns the timeline of the grinder chosen in the widget', async () => {
    const kitchen = fakeGrinder('GRINDER-1', 'Kitchen')
    const office = fakeGrinder('GRINDER-2', 'Office')
    devices.set('e64ws', [kitchen, office])

    expect(await widgetApi.getTimeline(request({ device: 'GRINDER-2', count: '10' }))).toEqual([{ id: 'GRINDER-2', limit: 10 }])
    expect(kitchen.widgetTimeline).not.toHaveBeenCalled()
  })

  it('shows 5 entries for a missing or unexpected count', async () => {
    devices.set('e64ws', [fakeGrinder('GRINDER-1', 'Kitchen')])

    expect(await widgetApi.getTimeline(request({ device: 'GRINDER-1' }))).toEqual([{ id: 'GRINDER-1', limit: 5 }])
    expect(await widgetApi.getTimeline(request({ device: 'GRINDER-1', count: '1000' }))).toEqual([{ id: 'GRINDER-1', limit: 5 }])
  })

  it('can show a single entry', async () => {
    devices.set('e64ws', [fakeGrinder('GRINDER-1', 'Kitchen')])

    expect(await widgetApi.getTimeline(request({ device: 'GRINDER-1', count: '1' }))).toEqual([{ id: 'GRINDER-1', limit: 1 }])
  })

  it('explains when the grinder is no longer in Homey', async () => {
    devices.set('e64ws', [fakeGrinder('GRINDER-1', 'Kitchen')])

    await expect(widgetApi.getTimeline(request({ device: 'GONE' }))).rejects.toThrow('widget.noDevice')
  })
})

describe('widget grinder setting', () => {
  async function autocomplete(query: string) {
    const app = new (MahlkoenigSyncApp as unknown as new (homey: FakeHomey) => { onInit(): Promise<void> })(homey)
    await app.onInit()
    return widgetAutocomplete.get('device')!(query)
  }

  it('lists the E64 WS devices by name, sorted, filtered by the query', async () => {
    devices.set('e64ws', [fakeGrinder('GRINDER-2', 'Office'), fakeGrinder('GRINDER-1', 'Kitchen')])

    expect(await autocomplete('')).toEqual([
      { name: 'Kitchen', id: 'GRINDER-1' },
      { name: 'Office', id: 'GRINDER-2' },
    ])
    expect(await autocomplete(' kit ')).toEqual([{ name: 'Kitchen', id: 'GRINDER-1' }])
  })
})
