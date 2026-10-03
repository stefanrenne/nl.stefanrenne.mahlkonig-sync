# History

## Before 1.0.0 (unreleased, 2026-10-01 – 2026-10-02)

The app was built from an empty repository. Nothing has been released or committed yet.

1. **HA integration studied.** The community Home Assistant integration
   (tomereli/ha-mahlkoenig-sync, MIT) reads `POST /api/dashboard-service/shot-history/query` with
   a `storeId`, the endpoint behind the web dashboard. Documented in `docs/sync-api.md`.
2. **Live probe** (`scripts/probe.mjs`). Login works and returns a 600 s JWT, a refresh token
   valid for days, and the company id (`details.comp`), but **no store id**.
3. **Web dashboards read.** The admin dashboard's JavaScript revealed the refresh endpoint and the
   store and device lists; the chart app showed the shot-history query also takes `companyId`.
4. **Home accounts are refused.** The maintainer's account is a home ("FAM") account without a
   store: every shot-history body is refused (403/400), and the admin dashboard says "You are not
   allowed to access this page". The HA approach doesn't work for home users.
5. **Mobile app captured.** The official Sync iOS app is a Flutter app that ignores the phone's
   proxy (Charles showed `socket://`). mitmproxy in WireGuard mode captured it; no certificate
   pinning. It uses `/api/mobile-service/…`, which works for home accounts and has per-grind events
   with ids. That became the basis of the app.

## Deliberate decisions

These were the maintainer's calls. Don't file them as bugs or reopen them without being asked.

- **No Store ID in pairing.** Pairing asks for e-mail and password only. (The original brief asked
  for e-mail, password and Store ID; home accounts have no store and the mobile API doesn't need
  one.)
- **"Grind completed" fires for purges too**, with the tokens `portafilter_detected` and
  `is_purge`, so the user filters in the flow. (The maintainer first chose "never for purges", then
  changed it.)
- **`portafilter_detected` (boolean) instead of a `started_via` text token**: the raw
  `triggerMode` values aren't documented and only two are known, so the token answers the one
  question users have: was the portafilter inserted?
- **A purge is a grind below a weight threshold** (device setting, default 5 g), not "started with
  the start button".
- **Purges don't change the capabilities or the condition**: they always show the last real grind.
- **Grinder status as extra capabilities**: standby, motor temperature, disc usage and health,
  with firmware and the paired scale as read-only settings.
- **A separate Sync Scale driver with yield and shot time only**: no dose or ratio on the scale.
  The grinder keeps its shot capabilities and "Shot completed" card too, so with both devices a
  shot fires twice. That duplication is intended.
- **App id `nl.stefanrenne.mahlkonig-sync`**, the same as the GitHub repo and the local folder
  ("mahlkonig", no "oe"). The original brief said `nl.stefanrenne.mahlkoenig-sync`; it was changed
  before the first release. Don't change it again: an app id can't change after publishing.
- **Disc usage and disc health are hidden** (device and widget): the cloud's `discUsageTime` and
  `discHealth` are undocumented and their meaning couldn't be verified (`discHealth` was 0 on a
  nearly new grinder). Show them again only once their meaning is known.
- **The Espresso widget is one merged list of the last 24 hours**, like the official app's history:
  grinds and shots, each shot matched with the newest grind up to 15 minutes before it. A first
  version with "last grind/shot", "today", "status" and "recent grinds" sections was replaced on
  2026-10-02 at the maintainer's request. The widget never calls the cloud.
- **Every grinder poll reads the whole last 24 hours** (grinds and shots) instead of only "since the
  newest event seen". The shorter window made the widget's list miss events (2026-10-02: only 1 of
  4 events of the day reached it).
- **`.mts` instead of `.ts`.** The brief named `lib/SyncClient.ts`; the file is
  `lib/SyncClient.mts` to match the maintainer's other apps (TypeScript as ES modules).
