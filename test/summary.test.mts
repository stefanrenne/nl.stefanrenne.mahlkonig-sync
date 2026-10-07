import { describe, expect, it } from 'vitest'
import { emptyTrackerState, type Brew, type Grind } from '../lib/events.mjs'
import { buildTimeline, timelineFromState } from '../lib/summary.mjs'

let counter = 0
function grind(at: string, doseG: number | null = 18, doseTargetG: number | null = 20): Grind {
  counter += 1
  return {
    uuid: `grind-${counter}`,
    at: new Date(at).toISOString(),
    doseG,
    doseTargetG,
    grindSetting: 139,
    grindSettingTarget: 140,
    grindTimeS: 7.5,
    brewTimeTargetS: 25,
    triggerMode: 'PortafilterDetection',
    recipeMode: 'Gbw',
  }
}

function brew(at: string, yieldG: number | null = 36, shotTimeS: number | null = 27.5): Brew {
  counter += 1
  return { uuid: `brew-${counter}`, at: new Date(at).toISOString(), yieldG, shotTimeS }
}

const grindPart = (weightG: number | null, deviationG: number | null, targetG: number | null = 20) =>
  ({ weightG, targetG, deviationG, discDistance: 139 })

describe('buildTimeline', () => {
  it('lists the maintainer\'s day like the official app: the 13:31 grind matched with its shot, deviations from the 20 g target', () => {
    // 2 October 2026 (times UTC), from the official app's history screen.
    const purge = grind('2026-10-02T06:59:09Z', 1.6)
    const morning = grind('2026-10-02T06:59:43Z', 20)
    const afternoon = grind('2026-10-02T11:31:00Z', 0)
    const shot = brew('2026-10-02T11:32:10Z', 42.5, 28)
    const scaleOnly = brew('2026-10-02T12:40:00Z', 1.1, 454.5)

    expect(buildTimeline([purge, morning, afternoon], [shot, scaleOnly], 10)).toEqual([
      { at: scaleOnly.at, grind: null, brew: { weightG: 1.1, timeS: 454.5 }, ratio: null },
      // 0.0 g ground: no ratio, shown as "1: -" like the official app.
      { at: afternoon.at, grind: grindPart(0, -20), brew: { weightG: 42.5, timeS: 28 }, ratio: null },
      { at: morning.at, grind: grindPart(20, 0), brew: null, ratio: null },
      { at: purge.at, grind: grindPart(1.6, -18.4), brew: null, ratio: null },
    ])
  })

  it('shows only the newest entries, as many as asked', () => {
    const grinds = [grind('2026-10-02T07:00:00Z'), grind('2026-10-02T08:00:00Z'), grind('2026-10-02T09:00:00Z')]

    expect(buildTimeline(grinds, [], 2).map((entry) => entry.at)).toEqual([grinds[2].at, grinds[1].at])
    expect(buildTimeline(grinds, [], 0)).toEqual([])
  })

  it('computes the ratio of a matched pair with one decimal', () => {
    const entries = buildTimeline([grind('2026-10-02T10:00:00Z', 18.1)], [brew('2026-10-02T10:02:00Z', 36.4)], 5)

    expect(entries[0].ratio).toBe(2)
  })

  it('matches a shot with the newest grind at most 15 minutes before it', () => {
    const early = grind('2026-10-02T10:00:00Z')
    const late = grind('2026-10-02T10:05:00Z')
    const shot = brew('2026-10-02T10:20:00Z')
    const tooLate = brew('2026-10-02T10:21:00Z')

    const entries = buildTimeline([early, late], [shot, tooLate], 10)

    expect(entries.find((entry) => entry.at === late.at)?.brew).not.toBeNull()
    expect(entries.find((entry) => entry.at === early.at)?.brew).toBeNull()
    // 16 minutes after the newest grind, and the older grind is already taken: shot only.
    expect(entries.find((entry) => entry.at === tooLate.at)).toMatchObject({ grind: null })
  })

  it('never matches a grind after the shot, and gives each grind at most one shot', () => {
    const before = grind('2026-10-02T10:00:00Z')
    const first = brew('2026-10-02T10:01:00Z')
    const second = brew('2026-10-02T10:03:00Z')
    const after = grind('2026-10-02T10:04:00Z')

    const entries = buildTimeline([before, after], [first, second], 10)

    expect(entries.map((entry) => [entry.at, entry.grind !== null, entry.brew !== null])).toEqual([
      [after.at, true, false],
      [second.at, false, true],
      [before.at, true, true],
    ])
  })

  it('lists each event once and keeps unknown values as null', () => {
    const unknown = grind('2026-10-02T10:00:00Z', null, null)

    expect(buildTimeline([unknown, unknown], [brew('2026-10-02T12:00:00Z', null, null)], 10)).toEqual([
      { at: '2026-10-02T12:00:00.000Z', grind: null, brew: { weightG: null, timeS: null }, ratio: null },
      { at: '2026-10-02T10:00:00.000Z', grind: grindPart(null, null, null), brew: null, ratio: null },
    ])
  })

  it('is empty without events', () => {
    expect(buildTimeline([], [], 5)).toEqual([])
  })
})

describe('timelineFromState', () => {
  it('uses the recent lists plus the last grind and shot', () => {
    const listed = grind('2026-10-02T09:00:00Z')
    const last = grind('2026-10-02T10:00:00Z')
    const shot = brew('2026-10-02T10:01:00Z')

    const entries = timelineFromState({ ...emptyTrackerState(), recentGrinds: [listed], lastRealGrind: last, lastBrew: shot }, 5)

    expect(entries.map((entry) => [entry.at, entry.brew !== null])).toEqual([[last.at, true], [listed.at, false]])
  })
})
