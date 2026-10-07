# TODO

Status: `[ ]` open, `[~]` in progress, `[?]` needs a decision or verification.

## Before the first release

- [ ] **Remaining checks on the maintainer's Homey Pro**: pairing, polling, the scale and the widget
  ran there on 2026-10-02 – 2026-10-07. Still to see: the flow cards firing ("Grind completed" with
  a purge and an unweighed grind, both "Shot completed" cards), the condition, repair, and the
  device going unavailable without internet and recovering.
- [?] **Terms of use: decide before publishing** (`docs/sync-api.md`, Q14). Read on 2026-10-07:
  no explicit ban on API access or third-party apps, but §7 allows suspending an account that
  gives "unauthorized third parties" access, and §4 limits use to private, non-commercial use.
  Options: publish with the README's disclaimer (risk on the user's account), or ask Mahlkönig
  first (sync@mahlkoenig.com).
- [ ] Add `homeyCommunityTopicId` to `.homeycompose/app.json` once there's a forum topic.

- [ ] **Espresso widget on a real dashboard, remaining checks**: light mode, tablet width, the count
  setting (1 hides the timeline), refreshing after a grind, the empty and "choose a grinder" states.

## Verify on real data

- [?] **Units**: °C for `measure_temperature` (`motorTemperature`, 34). (`grind_setting` is the
  disc distance in µm, confirmed by the official app.)
- [?] **Disc usage / disc health** (`discUsageTime`, `discHealth` in the status block): hidden
  until their meaning is known. Compare with what the Sync app shows about disc wear; if it
  matches, add them back as capabilities and in the widget (docs/history.md).
  (`.homeycompose/capabilities/`)
- [?] **Multiple grinders** (Q9): pairing lists all grinders of the company, and each device polls
  its own `deviceIds`, so this should work, but it's untested. Two grinders get the same name on
  purpose (docs/history.md); the user renames them in Homey.
