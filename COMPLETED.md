# Completed

Finished work with its context, newest first. Check here before re-investigating something that
sounds familiar.

## Before 1.0.0 (unreleased, 2026-10-07)

- **A 0.0 g grind counted as a purge.** The grinder reports `weightActual: 0` when it didn't weigh a
  grind (2026-10-02 13:31, target 20 g, followed by a 42.5 g shot; the official app shows −20 g).
  The purge rule (dose < 5 g) fired "Grind completed" with `is_purge` and kept the previous grind
  on the capabilities. Decision and fix: 0 mg parses as an unknown dose (`doseG: null`), which is
  never a purge. Tests: `test/events.test.mts` "treats a grind weight of 0 as unknown…",
  `test/device.test.mts` "treats an unweighed (0.0 g) grind as a real grind…".
- **Per-grind capabilities kept stale values.** `show()` skips unknown values, so an unknown dose or
  a recipe without a target left the previous grind's value on the device. Fix: the grind
  capabilities use `showOrClear()` (`lib/SyncDevice.mts`), which sets null. Test:
  `test/device.test.mts` "clears a target when the recipe of the newest grind has none".
- **The Sync Scale's "Paired grinder" label went stale after re-pairing.** It was only set at
  pairing. Fix: the scale device refreshes `serial` and `grinder` every 10 minutes via
  `listScales()`; a cloud error is only logged. Test: `test/scale.test.mts` "keeps its serial and
  paired-grinder labels current…".
- **Verified on live data (2026-10-02):** `brew-event/find` returns shots in the assumed shape (the
  app showed 1.1 g / 454.5 s and 42.5 g / 28.0 s, matching the official app), and scale listing
  works for a home account (the Sync Scale was paired).

## Before 1.0.0 (unreleased, 2026-10-01 – 2026-10-02)

- **The grinder device stopped starting after disc usage/health were hidden.** The migration called
  `removeCapability('disc_health')`, but the capability's definition had been deleted too, and Homey
  rejects removing an unknown capability ("Invalid Capability", 404). `onInit` failed, so the device
  never polled and the widget showed stale data ("today: 0"). Fix: the definitions are back in
  `.homeycompose/capabilities/` (not in the driver), and a failed removal is only logged. Gotcha:
  never delete a capability definition while a migration still removes it. Tests:
  `test/device.test.mts` "keeps starting and polling when removing an old capability fails",
  `test/manifest.test.mts` "capabilities removed from existing devices are still defined".
- **The widget missed most of the day's events.** Polls only read from 5 minutes before the
  newest event seen, and the recent lists only took first-seen events, so on 2026-10-02 only 1 of
  the 4 events of the day reached the widget (and that one, a 0.0 g grind, counted as a purge).
  Fix: every poll reads the whole last 24 hours and merges everything into the recent lists.
  Tests: `test/device.test.mts` "reads the whole last 24 hours on every poll…",
  `test/summary.test.mts` "lists the maintainer's day like the official app…".

- **Repo, folder and app id all renamed to `nl.stefanrenne.mahlkonig-sync`** (GitHub repo was
  `nl.stefanrenne.mahlkonig`; the app id and local folder were `nl.stefanrenne.mahlkoenig-sync`).
  The app had never been published, so the id change had no effect on users. Gotcha: a test
  install under the old id (`nl.stefanrenne.mahlkoenig-sync`) may still be on the maintainer's
  Homey; remove it there.
- **The HA integration's endpoint doesn't work for home accounts.** The shot-history query
  (`dashboard-service/shot-history/query`) needs a `storeId`; a home ("FAM") account has none, and
  every alternative body (`companyId`, `grinderId`, both, as numbers or strings) is refused with
  403/400. The admin web dashboard refuses home accounts outright. Fix: the app uses the mobile API
  instead (`docs/sync-api.md`, Mobile API). Gotcha: don't "simplify" back to the HA endpoint.
- **Charles showed `socket://` instead of `https://`** for the Sync app. The app is Flutter and
  ignores the phone's HTTP proxy, so a proxy only sees raw TLS. Fix: mitmproxy in WireGuard mode
  (`mitmweb --mode wireguard -s scripts/capture.py`), which captures all traffic; the app does no
  certificate pinning.
- **The first capture redaction missed identifiers.** Keys like `toBrewerId`, `fromDeviceId`,
  `profileId` and the `?key=` query value passed through `scripts/capture.py`. Fix: any key ending
  in a device/user/organisation id is now aliased (`ID_KEY_RE`), plus `key` and `profileId`.
  Gotcha: check every new capture for leaks before using it (grep for known serials/ids).
- **The probe tested the refresh before the queries**, which made it unclear whether later 403s
  were caused by the refresh. They weren't (the refresh returned the same token), but the probe
  now refreshes last. Gotcha: run anything that can change session state at the end of a probe.
- **A probe report was deleted by a cleanup command** (`rm -rf probe-output` after an offline test
  also removed a real report; it was restored from its already-read content). Gotcha: in
  `probe-output/`, only ever delete files by exact name.
