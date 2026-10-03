import { describe, expect, it } from 'vitest'
import { emptyTrackerState, type Brew, type Grind } from '../lib/events.mjs'
import { buildTimeline, timelineFromState } from '../lib/summary.mjs'

let counter = 0
function grind(at: string, doseG: number | null = 18, grindSetting = 139): Grind {
  counter += 1
  return {
    uuid: `grind-${counter}`,
    at: new Date(at).toISOString(),
    doseG,
    doseTargetG: 20,
    grindSetting,
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

const NOW = Date.parse('2026-10-02T17:30:00Z')

describe('buildTimeline', () => {
  it('lists the maintainer\'s day like the official app: 4 entries, the 13:31 grind matched with its shot', () => {
    // 2 October 2026 (times UTC), from the official app's history screen.
    const purge = grind('2026-10-02T06:59:09Z', 1.6)
    const morning = grind('2026-10-02T06:59:43Z', 20)
    const afternoon = grind('2026-10-02T11:31:00Z', 0)
    const shot = brew('2026-10-02T11:32:10Z', 42.5, 28)
    const scaleOnly = brew('2026-10-02T12:40:00Z', 1.1, 454.5)

    expect(buildTimeline([purge, morning, afternoon], [shot, scaleOnly], NOW)).toEqual([
      { at: scaleOnly.at, grind: null, brew: { weightG: 1.1, timeS: 454.5 } },
      { at: afternoon.at, grind: { weightG: 0, discDistance: 139 }, brew: { weightG: 42.5, timeS: 28 } },
      { at: morning.at, grind: { weightG: 20, discDistance: 139 }, brew: null },
      { at: purge.at, grind: { weightG: 1.6, discDistance: 139 }, brew: null },
    ])
  })

  it('matches a shot with the newest grind at most 15 minutes before it', () => {
    const early = grind('2026-10-02T10:00:00Z')
    const late = grind('2026-10-02T10:05:00Z')
    const shot = brew('2026-10-02T10:20:00Z')
    const tooLate = brew('2026-10-02T10:21:00Z')

    const entries = buildTimeline([early, late], [shot, tooLate], NOW)

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

    const entries = buildTimeline([before, after], [first, second], NOW)

    expect(entries).toEqual([
      { at: after.at, grind: { weightG: 18, discDistance: 139 }, brew: null },
      { at: second.at, grind: null, brew: { weightG: 36, timeS: 27.5 } },
      { at: before.at, grind: { weightG: 18, discDistance: 139 }, brew: { weightG: 36, timeS: 27.5 } },
    ])
  })

  it('keeps only the last 24 hours, without duplicates', () => {
    const old = grind('2026-10-01T17:29:00Z')
    const recent = grind('2026-10-01T17:31:00Z')

    const entries = buildTimeline([old, recent, recent], [], NOW)

    expect(entries.map((entry) => entry.at)).toEqual([recent.at])
  })

  it('keeps unknown values as null', () => {
    expect(buildTimeline([grind('2026-10-02T10:00:00Z', null)], [brew('2026-10-02T12:00:00Z', null, null)], NOW)).toEqual([
      { at: '2026-10-02T12:00:00.000Z', grind: null, brew: { weightG: null, timeS: null } },
      { at: '2026-10-02T10:00:00.000Z', grind: { weightG: null, discDistance: 139 }, brew: null },
    ])
  })

  it('is empty without events', () => {
    expect(buildTimeline([], [], NOW)).toEqual([])
  })
})

describe('timelineFromState', () => {
  it('uses the recent lists plus the last grind and shot', () => {
    const listed = grind('2026-10-02T09:00:00Z')
    const last = grind('2026-10-02T10:00:00Z')
    const shot = brew('2026-10-02T10:01:00Z')

    const entries = timelineFromState({ ...emptyTrackerState(), recentGrinds: [listed], lastRealGrind: last, lastBrew: shot }, NOW)

    expect(entries.map((entry) => [entry.at, entry.brew !== null])).toEqual([[last.at, true], [listed.at, false]])
  })
})
