# TODO

Status: `[ ]` open, `[~]` in progress, `[?]` needs a decision or verification.

## Before the first release

- [ ] **Test on a real Homey Pro** with `homey app run`: pairing, the first poll, a grind, a purge
  and a shot with the Sync Scale, the condition, repair, and the device going unavailable without
  internet. Nothing has run on a Homey yet; all behaviour is covered by unit tests only.
- [?] **Brew events from `findBrewEvents` are unverified.** The capture day had no scale shots, so
  `POST mobile-service/device-event/brew-event/find` only returned `[]`. `parseBrew` assumes the
  same shape as `last-events.lastBrew` (`payload.mass` in mg, `payload.duration` in ms). Verify
  with a real shot (probe or capture) and turn a response into a fixture.
  (`lib/events.mts` `parseBrew`, `drivers/e64ws/device.mts` and `drivers/sync-scale/device.mts` `poll`)
- [?] **Terms of use** (`docs/sync-api.md`, Q14): check `https://www.mahlkoenig.com/pages/sync-terms-of-use`
  for anything against third-party access before publishing to the App Store.
- [ ] Add `homeyCommunityTopicId` to `.homeycompose/app.json` once there's a forum topic.

- [ ] **Try the Espresso widget's 24-hour list on a real dashboard**: light and dark, phone and
  tablet width, the grinder picker, refreshing after a grind, the empty and "choose a grinder"
  states, and that the day matches the official app's history.

## Verify on real data

- [?] **Brew time deviation in the widget**: the official app shows one next to the brew time
  (−3.0 s at 28.0 s on 2026-10-02), but its target doesn't match the recipe's `brewTimeRecipe`
  (25 s). Find where the app's target comes from (a brew-event field, or the cloud recipe) before
  showing it. Also confirm the colour rule (assumed: green within 5 %, red outside).
- [?] **A grind of 0.0 g counts as a purge.** On 2026-10-02 at 13:31 the grinder reported 0.0 g
  (target 20 g) followed by a 42.5 g shot; the official app shows it as a normal grind with a
  −20 g shortfall. The purge rule (dose < 5 g) fires "Grind completed" with `is_purge` and keeps
  the previous grind on the capabilities. Decide: treat 0.0 g as "weight unknown" (not a purge)?

- [?] **Units**: °C for `measure_temperature` (`motorTemperature`, 34). (`grind_setting` is the
  disc distance in µm, confirmed by the official app.)
- [?] **Disc usage / disc health** (`discUsageTime`, `discHealth` in the status block): hidden
  until their meaning is known. Compare with what the Sync app shows about disc wear; if it
  matches, add them back as capabilities and in the widget (docs/history.md).
  (`docs/sync-api.md` Q5; `.homeycompose/capabilities/`)
- [?] **Recipe mode values**: only `Gbw` seen. If others turn out to be codes (e.g. `Gbt`),
  consider showing a readable name instead of the raw value (`recipe_mode`).
- [?] **Wrong-password response** (`docs/sync-api.md` Q1): `SyncClient.createSession` treats
  400/401/403 as rejected credentials. Check with `node scripts/probe.mjs --bad-login`.
- [?] **Multiple grinders** (Q9): pairing lists all grinders of the company, and each device polls
  its own `deviceIds`, so this should work, but it's untested. Two grinders would also get the same
  name ("Mahlkönig E64 WS").

## Improvements

- [ ] `scripts/probe.mjs` still probes the web-dashboard shot-history query, which refuses home
  accounts. Point it at the mobile API (`last-events`, `grind-event/find`) so it's useful for
  verifying the items above without a phone capture.
- [?] A recipe target of 0 ("no target") leaves the previous target capability value in place
  (`device.mts` `show` skips null). Clear it instead? Needs a decision on what to show.
- [?] The Sync Scale's "Paired grinder" label is only set at pairing. Refresh it (like the
  grinder's status) if re-pairing a scale to another grinder turns out to be common.
- [?] Scale listing (`device-union/query`) is App-verified but hasn't been called by this app
  against the live API yet; check during the Homey test.
- [?] Pairing uses `admin-service/device/query` (works for the home account, Live). The mobile
  API's `device-union/query` with `deviceClasses: ["GRINDER"]` may be the more natural endpoint;
  untested.
