import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  brewRatio,
  doseForBrew,
  emptyTrackerState,
  ingestBrews,
  ingestGrinds,
  isPurge,
  parseBrew,
  startedByPortafilter,
  parseGrind,
  realGrindBefore,
  rememberBrews,
  type Brew,
  type Grind,
} from '../lib/events.mjs'
import type { RawGrindEvent } from '../lib/SyncClient.mjs'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

// The maintainer's purge (1.4 s, 1.6 g) and the 20 g shot right after it, from the app capture.
const [rawShot, rawPurge] = fixture('grind-events.json') as RawGrindEvent[]
const shot = parseGrind(rawShot)!
const purge = parseGrind(rawPurge)!

let counter = 0
function grind(at: string, doseG: number | null = 18): Grind {
  counter += 1
  return {
    uuid: `grind-${counter}`,
    at: new Date(at).toISOString(),
    doseG,
    doseTargetG: 18,
    grindSetting: 140,
    grindSettingTarget: 140,
    grindTimeS: 7.5,
    brewTimeTargetS: 25,
    triggerMode: 'PortafilterDetection',
    recipeMode: 'Gbw',
  }
}

function brew(at: string, yieldG = 36): Brew {
  counter += 1
  return { uuid: `brew-${counter}`, at: new Date(at).toISOString(), yieldG, shotTimeS: 27.5 }
}

describe('parseGrind', () => {
  it('converts milligrams to grams and milliseconds to seconds', () => {
    expect(shot).toEqual({
      uuid: '00000000-0000-4000-8000-000000000002',
      at: '2026-10-02T06:59:43.611Z',
      doseG: 20,
      doseTargetG: 20,
      grindSetting: 139,
      grindSettingTarget: 140,
      grindTimeS: 7.9,
      brewTimeTargetS: 25,
      triggerMode: 'PortafilterDetection',
      recipeMode: 'Gbw',
    })
    expect(purge).toMatchObject({ doseG: 1.6, grindTimeS: 1.4, triggerMode: 'StartButton' })
  })

  it('uses the grinder\'s device date, and the cloud date when that is missing', () => {
    expect(parseGrind({ ...rawShot, deviceDate: undefined })?.at).toBe('2026-10-02T06:59:43.762Z')
  })

  it('treats a grind weight of 0 as unknown, so it is never a purge', () => {
    const unweighed = parseGrind({ ...rawShot, payload: { ...rawShot.payload, weightActual: 0 } })!

    expect(unweighed.doseG).toBeNull()
    expect(isPurge(unweighed, 5)).toBe(false)
  })

  it('treats a recipe value of 0 as "no target"', () => {
    const parsed = parseGrind({ ...rawShot, payload: { ...rawShot.payload, weightRecipe: 0, brewTimeRecipe: 0 } })
    expect(parsed).toMatchObject({ doseTargetG: null, brewTimeTargetS: null })
  })

  it('returns null without an id or a usable date', () => {
    expect(parseGrind(null)).toBeNull()
    expect(parseGrind({ ...rawShot, eventUuid: undefined })).toBeNull()
    expect(parseGrind({ ...rawShot, deviceDate: 'nonsense', cloudDate: undefined })).toBeNull()
  })

  it('keeps missing values as null instead of 0', () => {
    expect(parseGrind({ eventUuid: 'x', deviceDate: '2026-10-02T07:00:00Z' })).toMatchObject({
      doseG: null, grindSetting: null, grindTimeS: null, triggerMode: null, recipeMode: null,
    })
  })
})

describe('parseBrew', () => {
  it('converts the scale\'s mass and duration', () => {
    expect(parseBrew(fixture('last-events.json').lastBrew)).toEqual({
      uuid: '00000000-0000-4000-8000-000000000003',
      at: '2026-09-29T07:00:01.881Z',
      yieldG: 1,
      shotTimeS: 4,
    })
  })
})

describe('isPurge', () => {
  it('is true below the threshold, whatever started the grind', () => {
    expect(isPurge(purge, 5)).toBe(true)
    expect(isPurge(shot, 5)).toBe(false)
    expect(isPurge({ ...shot, triggerMode: 'StartButton' }, 5)).toBe(false)
    expect(isPurge({ ...purge, triggerMode: 'PortafilterDetection' }, 5)).toBe(true)
  })

  it('follows the threshold setting and never calls an unknown dose a purge', () => {
    expect(isPurge(purge, 1)).toBe(false)
    expect(isPurge(shot, 25)).toBe(true)
    expect(isPurge({ ...shot, doseG: null }, 25)).toBe(false)
  })
})

describe('startedByPortafilter', () => {
  it('is true only for portafilter detection', () => {
    expect(startedByPortafilter(shot)).toBe(true)
    expect(startedByPortafilter(purge)).toBe(false)
    expect(startedByPortafilter({ ...shot, triggerMode: null })).toBe(false)
    expect(startedByPortafilter({ ...shot, triggerMode: 'SomethingNew' })).toBe(false)
  })
})

describe('brew ratio and dose pairing', () => {
  it('computes yield ÷ dose with two decimals', () => {
    expect(brewRatio(36.4, 18.1)).toBe(2.01)
    expect(brewRatio(null, 18)).toBeNull()
    expect(brewRatio(36, null)).toBeNull()
    expect(brewRatio(36, 0)).toBeNull()
  })

  it('takes the dose of a grind up to 15 minutes before the shot', () => {
    const before = grind('2026-10-02T07:00:00Z', 18.1)
    expect(doseForBrew(brew('2026-10-02T07:01:00Z'), before)).toBe(18.1)
    expect(doseForBrew(brew('2026-10-02T07:15:00Z'), before)).toBe(18.1)
    expect(doseForBrew(brew('2026-10-02T07:16:00Z'), before)).toBeNull()
    expect(doseForBrew(brew('2026-10-02T06:59:00Z'), before)).toBeNull()
    expect(doseForBrew(brew('2026-10-02T07:01:00Z'), null)).toBeNull()
  })
})

describe('ingestGrinds (new grind detection)', () => {
  it('sets a baseline on the first poll without reporting old grinds as new', () => {
    const { state, newGrinds } = ingestGrinds(emptyTrackerState(), [shot, purge], 5)

    expect(newGrinds).toEqual([])
    expect(state.initialized).toBe(true)
    expect(state.lastGrindAt).toBe(shot.at)
    expect(state.lastRealGrind?.uuid).toBe(shot.uuid)
    expect(state.seenGrindUuids).toEqual([purge.uuid, shot.uuid])
  })

  it('reports each new grind once, oldest first, purges included', () => {
    const baseline = ingestGrinds(emptyTrackerState(), [], 5).state

    const first = ingestGrinds(baseline, [shot, purge], 5)
    expect(first.newGrinds.map((g) => g.uuid)).toEqual([purge.uuid, shot.uuid])

    // The next poll's window overlaps: the same grinds come back and must not fire again.
    const second = ingestGrinds(first.state, [shot, purge], 5)
    expect(second.newGrinds).toEqual([])
  })

  it('does not report anything when the response has not changed', () => {
    const baseline = ingestGrinds(emptyTrackerState(), [shot], 5).state
    expect(ingestGrinds(baseline, [shot], 5).newGrinds).toEqual([])
  })

  it('keeps the last real grind when a purge follows it', () => {
    const baseline = ingestGrinds(emptyTrackerState(), [], 5).state
    const real = grind('2026-10-02T07:00:00Z', 18)
    const laterPurge = grind('2026-10-02T07:01:00Z', 1.2)

    const { state, newGrinds } = ingestGrinds(baseline, [laterPurge, real], 5)

    expect(newGrinds.map((g) => g.uuid)).toEqual([real.uuid, laterPurge.uuid])
    expect(state.lastRealGrind?.uuid).toBe(real.uuid)
    expect(state.lastGrindAt).toBe(laterPurge.at)
  })

  it('catches a shot that a later purge in the same poll would hide from "last event"', () => {
    const baseline = ingestGrinds(emptyTrackerState(), [grind('2026-10-02T06:00:00Z')], 5).state
    const real = grind('2026-10-02T07:00:00Z', 18)
    const laterPurge = grind('2026-10-02T07:00:30Z', 1)

    expect(ingestGrinds(baseline, [laterPurge, real], 5).newGrinds.map((g) => g.uuid)).toEqual([real.uuid, laterPurge.uuid])
  })

  it('ignores grinds older than the newest one already seen', () => {
    const baseline = ingestGrinds(emptyTrackerState(), [grind('2026-10-02T07:00:00Z')], 5).state
    const older = grind('2026-10-02T06:00:00Z')

    expect(ingestGrinds(baseline, [older], 5).newGrinds).toEqual([])
  })

  it('remembers a bounded number of grind ids', () => {
    let state = ingestGrinds(emptyTrackerState(), [], 5).state
    for (let minute = 0; minute < 250; minute += 1) {
      state = ingestGrinds(state, [grind(new Date(Date.parse('2026-10-02T00:00:00Z') + minute * 60_000).toISOString())], 5).state
    }
    expect(state.seenGrindUuids).toHaveLength(200)
  })

  it('uses the threshold for the last real grind', () => {
    const baseline = ingestGrinds(emptyTrackerState(), [], 5).state
    expect(ingestGrinds(baseline, [purge], 1).state.lastRealGrind?.uuid).toBe(purge.uuid)
    expect(ingestGrinds(baseline, [purge], 5).state.lastRealGrind).toBeNull()
  })
})

describe('ingestBrews', () => {
  it('sets a baseline without reporting old shots', () => {
    const old = brew('2026-10-02T06:00:00Z')
    const { state, newBrews } = ingestBrews(emptyTrackerState(), [old], true)
    expect(newBrews).toEqual([])
    expect(state.lastBrew?.uuid).toBe(old.uuid)
  })

  it('reports new shots once, oldest first', () => {
    const old = brew('2026-10-02T06:00:00Z')
    const start = ingestBrews(emptyTrackerState(), [old], true).state
    const first = brew('2026-10-02T07:00:00Z')
    const second = brew('2026-10-02T07:01:00Z')

    const update = ingestBrews(start, [second, old, first], false)
    expect(update.newBrews.map((b) => b.uuid)).toEqual([first.uuid, second.uuid])
    expect(update.state.lastBrew?.uuid).toBe(second.uuid)

    expect(ingestBrews(update.state, [second, first], false).newBrews).toEqual([])
  })

  it('leaves the state alone when there are no shots', () => {
    const state = emptyTrackerState()
    expect(ingestBrews(state, [], false)).toEqual({ state, newBrews: [] })
  })
})

describe('recent events for the widget', () => {
  it('keeps the grinds of the baseline and of later polls, oldest first, without duplicates', () => {
    const baseline = ingestGrinds(emptyTrackerState(), [shot, purge], 5).state
    expect(baseline.recentGrinds.map((g) => g.uuid)).toEqual([purge.uuid, shot.uuid])

    const later = grind('2026-10-02T08:00:00Z')
    const next = ingestGrinds(baseline, [later, shot], 5).state
    expect(next.recentGrinds.map((g) => g.uuid)).toEqual([purge.uuid, shot.uuid, later.uuid])
  })

  it('keeps the newest 100 grinds', () => {
    let state = ingestGrinds(emptyTrackerState(), [], 5).state
    for (let minute = 0; minute < 120; minute += 1) {
      state = ingestGrinds(state, [grind(new Date(Date.parse('2026-10-02T00:00:00Z') + minute * 60_000).toISOString())], 5).state
    }
    expect(state.recentGrinds).toHaveLength(100)
    expect(state.recentGrinds.at(-1)?.at).toBe('2026-10-02T01:59:00.000Z')
  })

  it('remembers shots, also on the baseline, and keeps the newest 50', () => {
    const old = brew('2026-10-02T06:00:00Z')
    const update = ingestBrews(emptyTrackerState(), [old], true)
    expect(update.newBrews).toEqual([])

    let state = rememberBrews(update.state, [old])
    expect(state.recentBrews).toEqual([old])
    expect(rememberBrews(state, [])).toBe(state)

    for (let minute = 1; minute <= 60; minute += 1) {
      state = rememberBrews(state, [brew(new Date(Date.parse('2026-10-02T06:00:00Z') + minute * 60_000).toISOString())])
    }
    expect(state.recentBrews).toHaveLength(50)
    expect(state.recentBrews[0].at).toBe('2026-10-02T06:11:00.000Z')
  })
})

describe('realGrindBefore', () => {
  it('picks the newest real grind at or before the shot', () => {
    const early = grind('2026-10-02T07:00:00Z', 18)
    const late = grind('2026-10-02T07:05:00Z', 18.5)
    const purgeAfter = grind('2026-10-02T07:06:00Z', 1)
    const afterShot = grind('2026-10-02T07:20:00Z', 19)
    const shotAt = brew('2026-10-02T07:10:00Z')

    expect(realGrindBefore(shotAt, [early, null, afterShot, purgeAfter, late], 5)).toBe(late)
    expect(realGrindBefore(shotAt, [purgeAfter, afterShot], 5)).toBeNull()
  })
})
