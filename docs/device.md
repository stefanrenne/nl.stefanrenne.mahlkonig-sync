# The `e64ws` device

Files: `drivers/e64ws/driver.mts`, `drivers/e64ws/device.mts`, `drivers/e64ws/driver*.compose.json`.
The cloud calls are in `lib/SyncClient.mts`, the event logic in `lib/events.mts`. Pairing, repair,
the poll loop, backoff and the capability helpers are shared with the Sync Scale driver
(`docs/scale.md`) through `lib/SyncDriver.mts` and `lib/SyncDevice.mts`.

## Pairing and repair

| Step | View | What happens |
|---|---|---|
| 1 | `login_credentials` (Homey template) | `login` handler: trims the e-mail, calls `SyncClient.login()`. Rejected credentials (`SyncAuthError`) return `false` (Homey shows "invalid credentials"); any other failure throws `pair.unreachable`. |
| 2 | `list_devices` | `SyncClient.listGrinders()`: `POST admin-service/device/query` with the company id from the login response, scales filtered out; falls back to the device of the newest grind event when that list is refused or empty. No grinders → `pair.noGrinders`. |
| 3 | `add_devices` | Each device gets `data: { id: <deviceId as string> }` and `store: { email, password }`. Name: `deviceName()` (`lib/names.mts`) → "Mahlkönig E64 WS". |

There is no Store ID: home accounts don't have one, and the mobile API doesn't need it
(`docs/sync-api.md`, Q8).

**Repair** reuses `login_credentials`: after a successful login it checks that the account lists
this device's id (else `pair.wrongAccount`), then calls `device.updateCredentials()`, which stores
the new credentials, creates a new client and polls immediately.

## Lifecycle

| Event | What happens |
|---|---|
| `onInit` | Gets the two trigger cards, creates a `SyncClient` from the store, schedules a poll at 0 ms. |
| Poll succeeds | `failures = 0`, `setAvailable()` if needed, next poll after `poll_interval` minutes. |
| Poll fails | `failures += 1`, `setUnavailable()` with `errors.auth` (for `SyncAuthError`) or `errors.unreachable` (with the error message), next poll after `poll_interval × 2^failures`, capped at 30 minutes. |
| `onSettings` with `poll_interval` changed | Reschedules with the new interval. |
| `onUninit` / `onDeleted` | Stops the timer; no further polls. |

All scheduling goes through `homey.setTimeout` / `homey.clearTimeout`.

## The poll cycle (`poll()`)

1. **Status** (first poll, then at most every 10 minutes): `getDevice(grinderId)` →
   `standby`, `measure_temperature`; `getScaleBinding(grinderId)` →
   remembers the scale id and adds the scale capabilities; updates the label settings `model`,
   `serial`, `firmware` (`hmiSwVersion / espSwVersion`) and `scale`. A `SyncApiError` here is
   logged and ignored, so grind detection still runs; a `SyncAuthError` fails the poll.
2. **Grinds**: `findGrindEvents(grinderId, now − 24 h, now + 5 min)`: every poll reads the whole
   last 24 hours, so the widget's list is complete and no event is missed. Parsed with
   `parseGrind`, fed to `ingestGrinds` (new = not seen before and not older than the newest seen).
3. **Shots** (only with a paired scale): `findBrewEvents(scaleId, …)` over the same 24 hours, fed
   to `ingestBrews`.
4. **Persist** the new `TrackerState` in the store key `tracker`.
5. **Capabilities**: the last real grind (never a purge) and the last shot.
6. **Triggers**: "Grind completed" for each new grind, then "Shot completed" for each new shot,
   oldest first, skipping events more than 60 minutes old (`MAX_TRIGGER_AGE_MS`). A failing
   trigger is logged and doesn't fail the poll.

Persisting before triggering means a crash or error after step 4 can lose a trigger but never
fires one twice.

7. **Widget**: when the poll found a new grind or shot, or refreshed the status, emit the realtime
   event `espresso.updated` with `{ deviceId }` (`docs/widget.md`). A failure is logged.

`widgetTimeline(now)` builds the widget's list from the tracker state (`lib/summary.mts`).

## Tracker state (store key `tracker`)

| Field | Meaning |
|---|---|
| `initialized` | `false` until the first successful poll. The first poll only sets the baseline: nothing fires for events that already existed when the device was added. |
| `lastGrindAt` | Device date of the newest grind seen (purge or not). Grinds older than this are never "new". |
| `seenGrindUuids` | The last 200 grind ids seen, so overlapping poll windows never fire twice. |
| `lastRealGrind` | The newest non-purge grind, as a parsed `Grind`. Source of the grind capabilities and of the condition. |
| `lastBrew` | The newest shot seen, as a parsed `Brew`. |
| `recentGrinds` | The newest 100 grinds (purges included), oldest first, merged from every poll's 24-hour read. Source of the Espresso widget's list. |
| `recentBrews` | The newest 50 shots, oldest first, filled the same way. |

The state survives app restarts; a missing or partial value is merged over `emptyTrackerState()`.

## Purges

`isPurge(grind, purge_threshold)`: the dose is known and below the threshold (default 5 g). How the
grind was started (`triggerMode`) doesn't matter. Purges fire "Grind completed" with
`is_purge: true` and don't touch `lastRealGrind`.

## Capabilities

| Capability | Source | Notes |
|---|---|---|
| `dose_weight` (g) | `lastRealGrind.doseG` | |
| `grind_setting` (µm) | `lastRealGrind.grindSetting` (`dddActual`) | The disc distance; µm per the official app |
| `grind_time` (s) | `lastRealGrind.grindTimeS` | |
| `last_grind` (string) | `lastRealGrind.at`, formatted with `Intl.DateTimeFormat` in the Homey language and time zone (`dateStyle`/`timeStyle: short`) | |
| `dose_target` (g), `grind_setting_target`, `brew_time_target` (s) | Recipe values of the last real grind | A recipe value of 0 means "no target" and leaves the capability unchanged |
| `recipe_mode` (string) | `payload.recipeMode`, raw (e.g. `Gbw`) | |
| `standby` (boolean) | `status.status.standbyActive` | |
| `measure_temperature` | `status.status.motorTemperature` | Titled "Motor temperature"; °C assumed |
| `yield_weight` (g), `shot_time` (s), `brew_ratio` | Last shot; ratio uses the dose of the last real grind ≤ 15 min before it | Added at runtime when a scale is paired or a shot is seen |

A capability is only written when the value is known (not `null`) and changed.

## Settings

| Id | Type | Default | Notes |
|---|---|---|---|
| `poll_interval` | number, minutes | 2 | Min 1, max 60 |
| `purge_threshold` | number, g | 5 | Min 0, max 50, step 0.5 |
| `model`, `serial`, `firmware`, `scale` | label | `-` | Written by the status refresh |

## Known issues

- With more than 200 grinds inside one poll window the seen-list could drop ids; the `lastGrindAt`
  check still prevents repeats. Not realistic for a home grinder.
- Brew events from `findBrewEvents` haven't been seen in a live response yet (the capture day had
  no shots); the parser assumes the same shape as `last-events.lastBrew`. See TODO.md.
- The °C of the motor temperature is unverified. See TODO.md.
- A grind can report 0.0 g (the official app shows it with its full shortfall to the target). The
  purge rule counts it as a purge, so it doesn't update the grind capabilities. See TODO.md.
- `discUsageTime` and `discHealth` from the status block are not shown: their meaning is unknown.
  Devices paired with an earlier build had `disc_usage` / `disc_health` capabilities; `onSyncInit`
  removes them. Their definitions stay in `.homeycompose/capabilities/` (not in the driver's list):
  Homey refuses to remove a capability the app no longer defines ("Invalid Capability", 404). A
  failed removal is logged and never stops the device from starting.
