// What the Espresso widget shows: one list of the last 24 hours in which each Sync Scale shot is
// matched with the grind before it, like the official Sync app's history. Pure, so the matching
// can be tested without Homey.
import { MAX_GRIND_TO_SHOT_MS, type Brew, type Grind, type TrackerState } from './events.mjs';

export const TIMELINE_WINDOW_MS = 24 * 60 * 60_000;

export interface TimelineEntry {
  /** The grind's time when there is one, else the shot's. */
  at: string;
  grind: { weightG: number | null; discDistance: number | null } | null;
  brew: { weightG: number | null; timeS: number | null } | null;
}

/**
 * Matches each shot with the newest grind at most 15 minutes before it that no other shot took,
 * and lists everything from the window, newest first. Every grind is listed, purges included,
 * as the official app does.
 */
export function buildTimeline(grinds: Grind[], brews: Brew[], now: number, windowMs = TIMELINE_WINDOW_MS): TimelineEntry[] {
  const since = now - windowMs;
  const inWindow = <T extends { uuid: string; at: string }>(events: T[]) =>
    [...new Map(events.map((event) => [event.uuid, event])).values()]
      .filter((event) => Date.parse(event.at) >= since && Date.parse(event.at) <= now)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const windowGrinds = inWindow(grinds);
  const windowBrews = inWindow(brews);
  const matched = new Map<string, Brew>();

  for (const brew of windowBrews) {
    const shotAt = Date.parse(brew.at);
    const grind = windowGrinds
      .filter((candidate) => !matched.has(candidate.uuid))
      .filter((candidate) => Date.parse(candidate.at) <= shotAt && shotAt - Date.parse(candidate.at) <= MAX_GRIND_TO_SHOT_MS)
      .at(-1);
    if (grind !== undefined) {
      matched.set(grind.uuid, brew);
    }
  }
  const matchedBrews = new Set([...matched.values()].map((brew) => brew.uuid));

  const entries: TimelineEntry[] = [
    ...windowGrinds.map((grind) => {
      const brew = matched.get(grind.uuid);
      return {
        at: grind.at,
        grind: { weightG: grind.doseG, discDistance: grind.grindSetting },
        brew: brew === undefined ? null : { weightG: brew.yieldG, timeS: brew.shotTimeS },
      };
    }),
    ...windowBrews
      .filter((brew) => !matchedBrews.has(brew.uuid))
      .map((brew) => ({ at: brew.at, grind: null, brew: { weightG: brew.yieldG, timeS: brew.shotTimeS } })),
  ];
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The timeline from a grinder device's stored state (its recent grinds and shots). */
export function timelineFromState(state: TrackerState, now: number): TimelineEntry[] {
  const withLast = <T extends { uuid: string }>(events: T[] | undefined, last: T | null) =>
    last === null ? events ?? [] : [...(events ?? []), last];
  return buildTimeline(withLast(state.recentGrinds, state.lastRealGrind), withLast(state.recentBrews, state.lastBrew), now);
}
