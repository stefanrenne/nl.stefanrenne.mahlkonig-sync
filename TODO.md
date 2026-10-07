# TODO

Status: `[ ]` open, `[~]` in progress, `[?]` needs a decision or verification.

## Before the first release

- [ ] **Remaining checks on the maintainer's Homey Pro**: pairing, polling, the scale and the widget
  ran there on 2026-10-02 – 2026-10-07. Still to see: the flow cards firing ("Grind completed" with
  a purge and an unweighed grind, both "Shot completed" cards), the condition, repair, and the
  device going unavailable without internet and recovering.
- [?] **Terms of use** (`docs/sync-api.md`, Q14): check `https://www.mahlkoenig.com/pages/sync-terms-of-use`
  for anything against third-party access before publishing to the App Store.
- [ ] Add `homeyCommunityTopicId` to `.homeycompose/app.json` once there's a forum topic.

- [ ] **Espresso widget on a real dashboard, remaining checks**: light mode, tablet width, the count
  setting (1 hides the timeline), refreshing after a grind, the empty and "choose a grinder" states.

## Verify on real data

- [?] **Brew time deviation in the widget**: the official app shows one next to the brew time
  (−3.0 s at 28.0 s on 2026-10-02), but its target doesn't match the recipe's `brewTimeRecipe`
  (25 s). Find where the app's target comes from (a brew-event field, or the cloud recipe) before
  showing it. Also confirm the colour rule (assumed: green within 5 %, red outside).
- [?] **Units**: °C for `measure_temperature` (`motorTemperature`, 34). (`grind_setting` is the
  disc distance in µm, confirmed by the official app.)
- [?] **Disc usage / disc health** (`discUsageTime`, `discHealth` in the status block): hidden
  until their meaning is known. Compare with what the Sync app shows about disc wear; if it
  matches, add them back as capabilities and in the widget (docs/history.md).
  (`.homeycompose/capabilities/`)
- [?] **Recipe mode values**: only `Gbw` seen. If others turn out to be codes (e.g. `Gbt`),
  consider showing a readable name instead of the raw value (`recipe_mode`).
- [?] **Wrong-password response** (`docs/sync-api.md` Q1): `SyncClient.createSession` treats
  400/401/403 as rejected credentials. Check with `node scripts/probe.mjs --bad-login`.
- [?] **Multiple grinders** (Q9): pairing lists all grinders of the company, and each device polls
  its own `deviceIds`, so this should work, but it's untested. Two grinders get the same name on
  purpose (docs/history.md); the user renames them in Homey.

## Improvements

- [ ] `scripts/probe.mjs` still probes the web-dashboard shot-history query, which refuses home
  accounts. Point it at the mobile API (`last-events`, `grind-event/find`) so it's useful for
  verifying the items above without a phone capture.
- [?] Pairing uses `admin-service/device/query` (works for the home account, Live). The mobile
  API's `device-union/query` with `deviceClasses: ["GRINDER"]` may be the more natural endpoint;
  untested.
