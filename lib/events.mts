// Turns raw Sync grind/brew events into values for Homey, and decides which events are new.
// Pure functions only, so the "new grind" detection can be tested without Homey or the cloud.
import type { RawBrewEvent, RawGrindEvent } from './SyncClient.mjs';

/** A grind as the app uses it. Weights in grams, times in seconds, `at` as an ISO string. */
export interface Grind {
  uuid: string;
  at: string;
  doseG: number | null;
  doseTargetG: number | null;
  grindSetting: number | null;
  grindSettingTarget: number | null;
  grindTimeS: number | null;
  brewTimeTargetS: number | null;
  triggerMode: string | null;
  recipeMode: string | null;
}

/** A Sync Scale shot. Weights in grams, times in seconds. */
export interface Brew {
  uuid: string;
  at: string;
  yieldG: number | null;
  shotTimeS: number | null;
}

/** What the device remembers between polls (persisted in the device store). */
export interface TrackerState {
  /** False until the first successful poll set the baseline; no triggers fire before that. */
  initialized: boolean;
  /** Device date of the newest grind seen, purge or not. */
  lastGrindAt: string | null;
  /** Recently seen grind ids, newest last, to never trigger twice for the same grind. */
  seenGrindUuids: string[];
  /** The newest grind that wasn't a purge: what the capabilities and the condition show. */
  lastRealGrind: Grind | null;
  /** The newest Sync Scale shot seen. */
  lastBrew: Brew | null;
}

const SEEN_LIMIT = 200;
/** A shot only gets a dose and ratio when the grind came at most this long before it. */
export const MAX_GRIND_TO_SHOT_MS = 15 * 60_000;

export function emptyTrackerState(): TrackerState {
  return { initialized: false, lastGrindAt: null, seenGrindUuids: [], lastRealGrind: null, lastBrew: null };
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const grams = (milligrams: unknown) => (typeof milligrams === 'number' ? round1(milligrams / 1000) : null);
const seconds = (milliseconds: unknown) => (typeof milliseconds === 'number' ? round1(milliseconds / 1000) : null);
const numberOrNull = (value: unknown) => (typeof value === 'number' ? value : null);
const stringOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/** The event's time: the grinder's own clock, or the cloud's receipt time when that's missing. */
function eventTime(event: { deviceDate?: string; cloudDate?: string }): string | null {
  for (const candidate of [event.deviceDate, event.cloudDate]) {
    if (candidate && Number.isFinite(Date.parse(candidate))) {
      return new Date(candidate).toISOString();
    }
  }
  return null;
}

export function parseGrind(raw: RawGrindEvent | null | undefined): Grind | null {
  const at = raw ? eventTime(raw) : null;
  if (!raw?.eventUuid || at === null) {
    return null;
  }
  const payload = raw.payload ?? {};
  return {
    uuid: raw.eventUuid,
    at,
    doseG: grams(payload.weightActual),
    // A recipe value of 0 means "no target" (seen for durationRecipe in grind-by-weight mode).
    doseTargetG: payload.weightRecipe ? grams(payload.weightRecipe) : null,
    grindSetting: numberOrNull(payload.dddActual),
    grindSettingTarget: payload.dddRecipe ? payload.dddRecipe : null,
    grindTimeS: seconds(payload.durationActual),
    brewTimeTargetS: payload.brewTimeRecipe ? seconds(payload.brewTimeRecipe) : null,
    triggerMode: stringOrNull(payload.triggerMode),
    recipeMode: stringOrNull(payload.recipeMode),
  };
}

export function parseBrew(raw: RawBrewEvent | null | undefined): Brew | null {
  const at = raw ? eventTime(raw) : null;
  if (!raw?.eventUuid || at === null) {
    return null;
  }
  return {
    uuid: raw.eventUuid,
    at,
    yieldG: grams(raw.payload?.mass),
    shotTimeS: seconds(raw.payload?.duration),
  };
}

/** True when the grinder started because the portafilter was inserted (not the start button or unknown). */
export function startedByPortafilter(grind: Grind): boolean {
  return grind.triggerMode === 'PortafilterDetection';
}

/** A purge is a grind below the dose threshold. A grind with an unknown dose is not a purge. */
export function isPurge(grind: Grind, purgeThresholdG: number): boolean {
  return grind.doseG !== null && grind.doseG < purgeThresholdG;
}

/** The dose for a shot: the last real grind, if it happened shortly before the shot. */
export function doseForBrew(brew: Brew, lastRealGrind: Grind | null): number | null {
  if (lastRealGrind?.doseG == null) {
    return null;
  }
  const gap = Date.parse(brew.at) - Date.parse(lastRealGrind.at);
  return gap >= 0 && gap <= MAX_GRIND_TO_SHOT_MS ? lastRealGrind.doseG : null;
}

/** Brew ratio yield ÷ dose, e.g. 2.0 for a 1:2 shot. */
export function brewRatio(yieldG: number | null, doseG: number | null): number | null {
  if (yieldG === null || doseG === null || doseG <= 0) {
    return null;
  }
  return Math.round((yieldG / doseG) * 100) / 100;
}

export interface GrindUpdate {
  state: TrackerState;
  /** Grinds to fire "Grind completed" for, oldest first. Empty on the baseline poll. */
  newGrinds: Grind[];
}

/**
 * Feeds the grinds of one poll into the tracker. The first call only sets the baseline, so
 * pairing the device (or reinstalling the app) doesn't replay old grinds as new ones.
 */
export function ingestGrinds(state: TrackerState, grinds: Grind[], purgeThresholdG: number): GrindUpdate {
  const seen = new Set(state.seenGrindUuids);
  const lastAt = state.lastGrindAt === null ? -Infinity : Date.parse(state.lastGrindAt);
  const unique = [...new Map(grinds.map((grind) => [grind.uuid, grind])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // A grind counts as new when it wasn't seen and isn't older than the newest one seen;
  // the second check stops grinds that dropped out of the seen list from coming back.
  const fresh = unique.filter((grind) => !seen.has(grind.uuid) && Date.parse(grind.at) >= lastAt);

  let { lastGrindAt, lastRealGrind } = state;
  for (const grind of fresh) {
    lastGrindAt = grind.at;
    if (!isPurge(grind, purgeThresholdG)) {
      lastRealGrind = grind;
    }
  }

  return {
    state: {
      ...state,
      initialized: true,
      lastGrindAt,
      lastRealGrind,
      seenGrindUuids: [...state.seenGrindUuids, ...fresh.map((grind) => grind.uuid)].slice(-SEEN_LIMIT),
    },
    newGrinds: state.initialized ? fresh : [],
  };
}

/** What the Sync Scale device remembers between polls (persisted in its device store). */
export interface ScaleState {
  initialized: boolean;
  lastBrew: Brew | null;
}

export function emptyScaleState(): ScaleState {
  return { initialized: false, lastBrew: null };
}

export interface BrewUpdate<S extends { lastBrew: Brew | null }> {
  state: S;
  /** Shots to fire "Shot completed" for, oldest first. Empty on the baseline poll. */
  newBrews: Brew[];
}

/**
 * Like ingestGrinds, for Sync Scale shots. `baseline` is true on the first poll, when shots
 * only set the starting point.
 */
export function ingestBrews<S extends { lastBrew: Brew | null }>(state: S, brews: Brew[], baseline: boolean): BrewUpdate<S> {
  const lastAt = state.lastBrew === null ? -Infinity : Date.parse(state.lastBrew.at);
  const fresh = [...new Map(brews.map((brew) => [brew.uuid, brew])).values()]
    .filter((brew) => brew.uuid !== state.lastBrew?.uuid && Date.parse(brew.at) >= lastAt)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (fresh.length === 0) {
    return { state, newBrews: [] };
  }
  return {
    state: { ...state, lastBrew: fresh[fresh.length - 1] },
    newBrews: baseline ? [] : fresh,
  };
}
