import { describe, expect, it } from 'vitest'
import { emptyTrackerState, type Brew, type Grind } from '../lib/events.mjs'
import { buildTimeline, qualityOf, timelineFromState } from '../lib/summary.mjs'

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

function brew(at: string, options: { yieldG?: number | null, shotTimeS?: number | null, grind?: Grind, quality?: Brew['quality'] } = {}): Brew {
  counter += 1
  return {
    uuid: `brew-${counter}`,
    at: new Date(at).toISOString(),
    yieldG: options.yieldG === undefined ? 36 : options.yieldG,
    shotTimeS: options.shotTimeS === undefined ? 27.5 : options.shotTimeS,
    grindUuid: options.grind?.uuid ?? null,
    quality: options.quality ?? null,
  }
}

describe('buildTimeline', () => {
  it('lists the maintainer\'s day like the official app, the shot joined to the grind the cloud links it to', () => {
    // 2 October 2026 (times UTC), from the official app's history screen. The 13:31 grind wasn't
    // weighed (unknown dose); its shot is linked by grindEventUuid.
    const purge = grind('2026-10-02T06:59:09Z', 1.6)
    const morning = grind('2026-10-02T06:59:43Z', 20)
    const afternoon = grind('2026-10-02T11:30:49Z', null)
    const shot = brew('2026-10-02T11:31:47Z', { yieldG: 42.5, shotTimeS: 28, grind: afternoon, quality: { brewTime: 'OK', grindWeight: null } })
    const scaleOnly = brew('2026-10-02T12:40:14Z', { yieldG: 1.1, shotTimeS: 454.5 })

    expect(buildTimeline([purge, morning, afternoon], [shot, scaleOnly], 10)).toEqual([
      {
        at: scaleOnly.at,
        grind: null,
        brew: { weightG: 1.1, timeS: 454.5, targetS: null, deviationS: null, quality: null },
        ratio: null,
      },
      {
        at: afternoon.at,
        grind: { weightG: null, targetG: 20, deviationG: null, quality: null, discDistance: 139 },
        // −3.0 s like the official app: target 25 s − 28 s.
        brew: { weightG: 42.5, timeS: 28, targetS: 25, deviationS: -3, quality: 'ok' },
        ratio: null,
      },
      { at: morning.at, grind: { weightG: 20, targetG: 20, deviationG: 0, quality: 'good', discDistance: 139 }, brew: null, ratio: null },
      { at: purge.at, grind: { weightG: 1.6, targetG: 20, deviationG: -18.4, quality: 'bad', discDistance: 139 }, brew: null, ratio: null },
    ])
  })

  it('never joins a shot without a link, however close it is to a grind', () => {
    const justBefore = grind('2026-10-02T10:00:00Z')
    const unlinked = brew('2026-10-02T10:01:00Z')

    expect(buildTimeline([justBefore], [unlinked], 10).map((entry) => [entry.grind !== null, entry.brew !== null])).toEqual([
      [false, true],
      [true, false],
    ])
  })

  it('lists a linked shot on its own when its grind isn\'t stored', () => {
    const missing = grind('2026-10-01T10:00:00Z')
    const shot = brew('2026-10-02T10:01:00Z', { grind: missing })

    expect(buildTimeline([], [shot], 10)).toEqual([
      { at: shot.at, grind: null, brew: { weightG: 36, timeS: 27.5, targetS: null, deviationS: null, quality: null }, ratio: null },
    ])
  })

  it('computes the ratio of a linked pair with one decimal', () => {
    const ground = grind('2026-10-02T10:00:00Z', 18.1)

    expect(buildTimeline([ground], [brew('2026-10-02T10:02:00Z', { yieldG: 36.4, grind: ground })], 5)[0].ratio).toBe(2)
  })

  it('uses the cloud\'s verdict for the colour when there is one, else the ±5/±10 % bands', () => {
    const ground = grind('2026-10-02T10:00:00Z', 19.5)
    const verdict = brew('2026-10-02T10:02:00Z', { shotTimeS: 30, grind: ground, quality: { brewTime: 'PERFECT', grindWeight: 'OK' } })

    const [entry] = buildTimeline([ground], [verdict], 5)

    expect(entry.grind?.quality).toBe('ok')
    expect(entry.brew?.quality).toBe('good')
    expect(qualityOf(-1, 20)).toBe('good')
    expect(qualityOf(1.5, 20)).toBe('ok')
    expect(qualityOf(-2.5, 20)).toBe('bad')
    expect(qualityOf(1, null)).toBeNull()
    expect(qualityOf(null, 20)).toBeNull()
  })

  it('shows only the newest entries, as many as asked', () => {
    const grinds = [grind('2026-10-02T07:00:00Z'), grind('2026-10-02T08:00:00Z'), grind('2026-10-02T09:00:00Z')]

    expect(buildTimeline(grinds, [], 2).map((entry) => entry.at)).toEqual([grinds[2].at, grinds[1].at])
    expect(buildTimeline(grinds, [], 0)).toEqual([])
  })

  it('lists each event once', () => {
    const ground = grind('2026-10-02T10:00:00Z')
    const shot = brew('2026-10-02T10:01:00Z', { grind: ground })

    expect(buildTimeline([ground, ground], [shot, shot], 10)).toHaveLength(1)
  })

  it('is empty without events', () => {
    expect(buildTimeline([], [], 5)).toEqual([])
  })
})

describe('timelineFromState', () => {
  it('uses the recent lists plus the last grind and shot', () => {
    const listed = grind('2026-10-02T09:00:00Z')
    const last = grind('2026-10-02T10:00:00Z')
    const shot = brew('2026-10-02T10:01:00Z', { grind: last })

    const entries = timelineFromState({ ...emptyTrackerState(), recentGrinds: [listed], lastRealGrind: last, lastBrew: shot }, 5)

    expect(entries.map((entry) => [entry.at, entry.brew !== null])).toEqual([[last.at, true], [listed.at, false]])
  })
})
