// What the Espresso widget shows: the latest grinds and Sync Scale shots as one timeline, each
// shot matched with the grind it belongs to, like the official Sync app's history. Pure, so the
// matching can be tested without Homey.
import { MAX_GRIND_TO_SHOT_MS, type Brew, type Grind, type TrackerState } from './events.mjs';

export interface TimelineEntry {
  /** The grind's time when there is one, else the shot's. */
  at: string;
  grind: {
    weightG: number | null;
    /** The recipe's target dose, when it has one. */
    targetG: number | null;
    /** weight − target, like the official app's "-20.0 g". */
    deviationG: number | null;
    discDistance: number | null;
  } | null;
  brew: { weightG: number | null; timeS: number | null } | null;
  /** Brew weight ÷ grind weight for a matched pair ("1:2.1"); null when it can't be computed. */
  ratio: number | null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Matches each shot with the newest grind at most 15 minutes before it that no other shot took,
 * and returns the newest `limit` entries, newest first. Every grind is listed, purges included,
 * as the official app does.
 */
export function buildTimeline(grinds: Grind[], brews: Brew[], limit: number): TimelineEntry[] {
  const unique = <T extends { uuid: string; at: string }>(events: T[]) =>
    [...new Map(events.map((event) => [event.uuid, event])).values()]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const allGrinds = unique(grinds);
  const allBrews = unique(brews);
  const matched = new Map<string, Brew>();

  for (const brew of allBrews) {
    const shotAt = Date.parse(brew.at);
    const grind = allGrinds
      .filter((candidate) => !matched.has(candidate.uuid))
      .filter((candidate) => Date.parse(candidate.at) <= shotAt && shotAt - Date.parse(candidate.at) <= MAX_GRIND_TO_SHOT_MS)
      .at(-1);
    if (grind !== undefined) {
      matched.set(grind.uuid, brew);
    }
  }
  const matchedBrews = new Set([...matched.values()].map((brew) => brew.uuid));

  const brewPart = (brew: Brew) => ({ weightG: brew.yieldG, timeS: brew.shotTimeS });
  const entries: TimelineEntry[] = [
    ...allGrinds.map((grind) => {
      const brew = matched.get(grind.uuid);
      const deviation = grind.doseG !== null && grind.doseTargetG !== null ? round1(grind.doseG - grind.doseTargetG) : null;
      return {
        at: grind.at,
        grind: { weightG: grind.doseG, targetG: grind.doseTargetG, deviationG: deviation, discDistance: grind.grindSetting },
        brew: brew === undefined ? null : brewPart(brew),
        ratio: brew !== undefined && brew.yieldG !== null && grind.doseG !== null && grind.doseG > 0
          ? round1(brew.yieldG / grind.doseG)
          : null,
      };
    }),
    ...allBrews
      .filter((brew) => !matchedBrews.has(brew.uuid))
      .map((brew) => ({ at: brew.at, grind: null, brew: brewPart(brew), ratio: null })),
  ];
  return entries
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, Math.max(0, limit));
}

/** The timeline from a grinder device's stored state (its recent grinds and shots). */
export function timelineFromState(state: TrackerState, limit: number): TimelineEntry[] {
  const withLast = <T extends { uuid: string }>(events: T[] | undefined, last: T | null) =>
    last === null ? events ?? [] : [...(events ?? []), last];
  return buildTimeline(withLast(state.recentGrinds, state.lastRealGrind), withLast(state.recentBrews, state.lastBrew), limit);
}
