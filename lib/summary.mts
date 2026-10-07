// What the Espresso widget shows: the latest grinds and Sync Scale shots as one timeline, each
// shot joined with the grind the Sync cloud links it to, like the official Sync app's history.
// Pure, so the matching and the deviations can be tested without Homey.
import { linkedGrind, type Brew, type Grind, type TrackerState } from './events.mjs';

/** Colour of a deviation: within 5 % of the target, within 10 %, or further off. */
export type Quality = 'good' | 'ok' | 'bad';

export interface TimelineEntry {
  /** The grind's time when there is one, else the shot's. */
  at: string;
  grind: {
    weightG: number | null;
    targetG: number | null;
    /** weight − target, like the official app's "-20.0 g". */
    deviationG: number | null;
    quality: Quality | null;
    discDistance: number | null;
  } | null;
  brew: {
    weightG: number | null;
    timeS: number | null;
    /** The linked grind's recipe brew time. */
    targetS: number | null;
    /** target − time: the official app shows "−3.0 sec" for 28.0 s against 25 s. */
    deviationS: number | null;
    quality: Quality | null;
  } | null;
  /** Brew weight ÷ grind weight for a linked pair ("1:2.1"); null when it can't be computed. */
  ratio: number | null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The cloud's verdict ("PERFECT", "OK", anything else) as a colour. */
function fromCloud(verdict: string | null | undefined): Quality | null {
  if (!verdict) {
    return null;
  }
  return verdict === 'PERFECT' ? 'good' : verdict === 'OK' ? 'ok' : 'bad';
}

/** A deviation against the recipe threshold bands (±5 % / ±10 %, from `recipe-threshold`). */
export function qualityOf(deviation: number | null, target: number | null): Quality | null {
  if (deviation === null || target === null || target <= 0) {
    return null;
  }
  const percent = (Math.abs(deviation) / target) * 100;
  return percent <= 5 ? 'good' : percent <= 10 ? 'ok' : 'bad';
}

function grindPart(grind: Grind, brew: Brew | undefined): TimelineEntry['grind'] {
  const deviation = grind.doseG !== null && grind.doseTargetG !== null ? round1(grind.doseG - grind.doseTargetG) : null;
  return {
    weightG: grind.doseG,
    targetG: grind.doseTargetG,
    deviationG: deviation,
    quality: fromCloud(brew?.quality?.grindWeight) ?? qualityOf(deviation, grind.doseTargetG),
    discDistance: grind.grindSetting,
  };
}

function brewPart(brew: Brew, grind: Grind | null): TimelineEntry['brew'] {
  const target = grind?.brewTimeTargetS ?? null;
  const deviation = target !== null && brew.shotTimeS !== null ? round1(target - brew.shotTimeS) : null;
  return {
    weightG: brew.yieldG,
    timeS: brew.shotTimeS,
    targetS: target,
    deviationS: deviation,
    quality: deviation === null ? null : fromCloud(brew.quality?.brewTime) ?? qualityOf(deviation, target),
  };
}

/**
 * Joins each shot with the grind the cloud links it to (`grindEventUuid`) and returns the newest
 * `limit` entries, newest first. Every grind is listed, purges included, as the official app does;
 * a shot without a link (or whose grind isn't stored) is listed on its own.
 */
export function buildTimeline(grinds: Grind[], brews: Brew[], limit: number): TimelineEntry[] {
  const unique = <T extends { uuid: string; at: string }>(events: T[]) =>
    [...new Map(events.map((event) => [event.uuid, event])).values()];

  const allGrinds = unique(grinds);
  const brewByGrind = new Map<string, Brew>();
  const loose: Brew[] = [];
  for (const brew of unique(brews)) {
    const grind = linkedGrind(brew, allGrinds);
    if (grind !== null && !brewByGrind.has(grind.uuid)) {
      brewByGrind.set(grind.uuid, brew);
    } else {
      loose.push(brew);
    }
  }

  const entries: TimelineEntry[] = [
    ...allGrinds.map((grind) => {
      const brew = brewByGrind.get(grind.uuid);
      return {
        at: grind.at,
        grind: grindPart(grind, brew),
        brew: brew === undefined ? null : brewPart(brew, grind),
        ratio: brew !== undefined && brew.yieldG !== null && grind.doseG !== null && grind.doseG > 0
          ? round1(brew.yieldG / grind.doseG)
          : null,
      };
    }),
    ...loose.map((brew) => ({ at: brew.at, grind: null, brew: brewPart(brew, null), ratio: null })),
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
