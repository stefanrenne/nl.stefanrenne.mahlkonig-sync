# Requirements

What the app must do, as agreed with the maintainer. `docs/sync-api.md` documents the API these
requirements are built on; where a requirement depends on an open question there, the question
is referenced.

## Goal

A Homey Pro app (SDK v3, TypeScript) that brings the data of a Mahlkönig E64 WS grinder into
Homey for use in flows. The E64 WS has no local API; it only talks to the Mahlkönig Sync cloud.
The app reads the same undocumented endpoints as the official Sync web dashboards, based on the
community Home Assistant integration
[tomereli/ha-mahlkoenig-sync](https://github.com/tomereli/ha-mahlkoenig-sync) (MIT).

## Process

1. Research first, build second. The API is documented in `docs/sync-api.md`.
2. Don't copy upstream code where its license doesn't allow it; reimplement the behaviour.
3. Don't invent endpoints or fields. Anything unclear is an open question in
   `docs/sync-api.md`, and building stops with a summary until it is resolved.

## Technical

- Homey SDK v3, TypeScript, Homey Compose (`.homeycompose/`).
- App id: `nl.stefanrenne.mahlkonig-sync`. (*Changed 2026-10-02* from `nl.stefanrenne.mahlkoenig-sync`
  in the original brief, to match the GitHub repo name.)
- Node built-ins (`fetch`) instead of heavy dependencies.
- The API client is a separate, testable module (`lib/SyncClient.ts`) with no Homey code in it.
- Code and comments in English.

## Driver `e64ws`

- **Pairing:** enter e-mail, password and Store ID; validate the credentials by logging in
  right away; then show the device to add.
  - *Update 2026-10-02:* a home account has no Store ID, and the mobile API doesn't need one
    (`docs/sync-api.md`, Q8). Pairing asks for e-mail and password only, logs in, and lists the
    account's grinders (`POST /admin-service/device/query` with the company id from the login
    response; works for home accounts).
- Credentials are stored in the device store, never in logs.
- Token refresh and re-login are handled automatically.
- Poll every 2 minutes; configurable in the device settings, minimum 1 minute.
- On errors: `setUnavailable()` with a clear message, exponential backoff, and `setAvailable()`
  when it recovers.

## Driver `sync-scale`

*Added 2026-10-02.* A separate driver for the Sync Scale:

- Pairing like the grinder (e-mail and password), then the account's scales.
- Capabilities: yield (g), shot time (s), last shot.
- Trigger "Shot completed" with yield and shot time.
- *Decision 2026-10-02:* **no dose or ratio** on the scale.
- *Decision 2026-10-02:* the grinder **keeps** its own shot capabilities and "Shot completed"
  card (with dose and ratio), so users without the scale device miss nothing. With both devices,
  a shot fires on both.

## Capabilities

Use standard Homey capabilities where they fit, custom ones otherwise.

From the grind and brew events (`POST /mobile-service/grind-event/find` and
`device-event/brew-event/find`; see `docs/sync-api.md`, Mobile API):

| Value | Source |
|---|---|
| Dose weight (g) | `payload.weightActual` |
| Grind setting | `payload.dddActual` (unit: Q5) |
| Grind time (s) | `payload.durationActual` |
| Time of the last grind | `deviceDate` |
| Yield (g) and shot time (s), only when there's Sync Scale data | brew `payload.mass`, `payload.duration` |
| Recipe target(s) and recipe mode, if the API provides them | `payload.*Recipe`, `recipeMode` |

*Added 2026-10-02*, from the grinder's device record (`GET /mobile-service/device/?key=<deviceId>`,
or `POST /admin-service/device/query` with `loadStatus` and `loadBindings`; see
`docs/sync-api.md`):

| Value | Source | Notes |
|---|---|---|
| Standby on/off | `status.status.standbyActive` | Boolean |
| Motor temperature | `status.status.motorTemperature` | Assumed °C (sample value 34); verify |
| Disc usage | `status.status.discUsageTime` | Unit unknown; verify before choosing a capability |
| Disc health | `status.status.discHealth` | Meaning and range unknown; verify |
| Firmware versions | `status.status.hmiSwVersion`, `espSwVersion`, `bundleVersion` | Read-only device settings (labels), not capabilities |
| Paired Sync Scale | `bindings[].brewer` with `type: "scale"` | Shown in device settings; decides whether yield/shot time capabilities are added |

## Flows

- **Trigger "Grind completed"** with tokens dose, grind setting, grind time, **portafilter
  detected** (boolean, *changed 2026-10-02* from a "started via" text token: true when
  `payload.triggerMode` is `PortafilterDetection`) and **is purge** (boolean). Fires once per new grind event (new `eventUuid`), not on every poll, and **also for
  purges**, so the user can filter on the tokens in the flow.
  - *Decision 2026-10-02* (the maintainer first chose "never fire for a purge", then changed it to
    this).
  - The API has no purge flag; the app derives it. *Decision 2026-10-02:* a grind is a purge
    when its dose (`weightActual`) is below a threshold set in the device settings (default
    5 g), whatever started it. (The maintainer's purge was 1.6 g, the shot 20 g.)
  - *Decision 2026-10-02:* purges don't update the capabilities (dose, grind setting, grind time,
    last grind) and don't count for the "last grind was less than X minutes ago" condition.
    Those always reflect the last real grind.
  - Because `last-events` only returns the newest grind, a purge right after a shot would hide
    the shot. The app therefore reads all new grind events since the last one it saw
    (`grind-event/find`) and processes them in order, so no grind is missed.
- **Trigger "Shot completed"** with tokens yield, shot time, dose, ratio.
- **Condition "Last grind was less than X minutes ago".**

## Other

- i18n: English and Dutch for all strings.
- README with installation, limitations (read-only, cloud-dependent, undocumented API) and a
  disclaimer that the app is not made by Mahlkönig.
- Unit tests for `SyncClient` and the "new grind" detection, with mocked responses.

## Delivery

- `homey app validate` passes.
- Instructions for testing the app on a Homey Pro with `homey app run`.
- A short list of open points and assumptions.
