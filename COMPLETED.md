# Completed

Finished work with its context, newest first. Check here before re-investigating something that
sounds familiar.

## Before 1.0.0 (unreleased, 2026-10-01 – 2026-10-02)

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
