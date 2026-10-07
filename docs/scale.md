# The `sync-scale` device

Files: `drivers/sync-scale/driver.mts`, `drivers/sync-scale/device.mts`,
`drivers/sync-scale/driver*.compose.json`. Shared behaviour (poll loop, backoff, availability,
repair, helpers) is in `lib/SyncDevice.mts` and `lib/SyncDriver.mts`, the same as for the grinder;
see `docs/device.md`.

The scale reports **yield and shot time only**. It has no dose or ratio: those need the grinder's
grind data and stay on the `e64ws` device (deliberate decision, `docs/history.md`). The grinder
device keeps its own shot capabilities and "Shot completed" card, so with both devices added each
shot fires on both.

## Pairing

| Step | What happens |
|---|---|
| `login_credentials` | Same as the grinder (`lib/SyncDriver.mts`). |
| `list_devices` | `SyncClient.listScales()`: `POST mobile-service/device-union/query` with `deviceClasses: ["SCALE"]` and `loadBindings: true`, as the official app does. If that's refused, it falls back to the scales in the `bindings` of `admin-service/device/query`. No scales → `pair.noScales`. |
| `add_devices` | Name "Sync Scale", `data: { id: <scale deviceId> }`, credentials in the store, and the label settings `serial` and `grinder` ("Mahlkönig E64 WS (serial)" of the paired grinder, or `settings.noGrinder`). |

The labels are refreshed every 10 minutes (and on the first poll) with `listScales()`, so
re-pairing the scale to another grinder in the Sync app shows up by itself. A cloud error there is
only logged and doesn't stop the shot polling.

## The poll cycle

1. `findBrewEvents(scaleId, from, now + 5 min)` with `from = max(now − 24 h, lastBrew.at − 5 min)`.
2. `ingestBrews` with the store key `tracker` (`ScaleState`: `initialized`, `lastBrew`). The first
   poll only sets the baseline.
3. Persist the state, then show `yield_weight`, `shot_time` and `last_shot` from the newest shot.
4. Fire `scale_shot_completed` for each new shot, oldest first, skipping shots more than 60 minutes
   old when first seen.

Errors, backoff and recovery are the same as the grinder's.

## Capabilities and settings

| Capability | Source |
|---|---|
| `yield_weight` (g) | `payload.mass` / 1000 |
| `shot_time` (s) | `payload.duration` / 1000 |
| `last_shot` (string) | The shot's `deviceDate`, formatted like `last_grind` |

| Setting | Notes |
|---|---|
| `poll_interval` | Minutes, default 2, min 1 |
| `serial`, `grinder` | Labels, written at pairing and refreshed every 10 minutes |

## Known issues

- Brew events haven't been seen in a live `brew-event/find` response yet; see TODO.md.
