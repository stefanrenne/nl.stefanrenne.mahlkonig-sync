# Flow cards

All cards are device cards defined in `drivers/<driver>/driver.flow.compose.json` (Homey adds the
device argument). Triggers are fired from the driver's `device.mts`; the condition's run listener
is registered in `drivers/e64ws/driver.mts`. Card ids are app-wide, hence `scale_shot_completed`
next to the grinder's `shot_completed`.

## Triggers

| Id | Tokens | Fires |
|---|---|---|
| `grind_completed` (E64 WS) | `dose` (number, g), `grind_setting` (number), `grind_time` (number, s), `started_via` (string, `payload.triggerMode`), `is_purge` (boolean) | Once per new grind event, **purges included**, oldest first. Not on the baseline poll, and not for grinds more than 60 minutes old when first seen. |
| `shot_completed` (E64 WS) | `yield` (number, g), `shot_time` (number, s), `dose` (number, g), `ratio` (number) | Once per new shot of the scale paired with the grinder, same rules. `dose` and `ratio` use the last real grind at most 15 minutes before the shot; both are `0` when there is none. |
| `scale_shot_completed` (Sync Scale) | `yield` (number, g), `shot_time` (number, s) | Once per new shot of that scale, same rules. No dose or ratio. With both devices added, a shot fires both cards. |

Unknown values are sent as `0` (numbers) or `''` (`started_via`), because Homey tokens can't be
null. `started_via` values seen so far: `PortafilterDetection`, `StartButton`.

`is_purge` follows the `purge_threshold` device setting (dose below it).

## Conditions

| Id | Args | True when |
|---|---|---|
| `last_grind_within` | `minutes` (number, 1–1440) | The last real grind (purges don't count) happened less than `minutes` ago. Invertible ("more than"). False when no grind has been seen. |

## Adding a card

1. Add it to the driver's `driver.flow.compose.json` with `en` and `nl` for every title, hint and
   token. No empty `args` or `tokens` arrays (they break cards in standard flows); a `title` on
   every argument (required for a verified app).
2. Trigger it from the device, or register its listener in the driver.
3. Test it in `test/device.test.mts` or `test/driver.test.mts`.
4. Run `homey app build`, and update this file and README.md.
