# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Homey Pro app that brings the grind and shot data of a Mahlkönig E64 WS grinder (and a paired
Sync Scale) into Homey. The grinder has no local API, so the app polls the **Mahlkönig Sync cloud**
through the same undocumented **mobile API** the official Sync iOS/Android app uses
(`/api/mobile-service/…`). Two drivers, `e64ws` (the grinder) and `sync-scale`, one dashboard widget
(`espresso`), no settings page. TypeScript as ES
modules (`.mts`, imported with `.mjs` extensions), Node 22, `platforms: ["local"]`.

## Commands

```bash
npm run build                                   # tsc into .homeybuild/
npm run lint                                    # eslint (flat config, typescript-eslint)
npm test                                        # type-check the tests, then vitest run
npm run test:watch
npx vitest run test/events.test.mts             # one file
npx vitest run -t "purge"                       # tests by name
homey app validate --level verified             # what CI runs, after lint and test
homey app run                                   # run on a Homey Pro in debug mode
node scripts/probe.mjs                          # probe the live API (see docs/sync-api.md)
mitmweb --mode wireguard -s scripts/capture.py  # capture the official app's traffic, redacted
```

## Tests are required

**Every feature and every bug fix must come with new unit tests, or extend the existing ones, in
the same change.** A change is not done until `npm test` and `npm run lint` pass. For a bug fix,
add a test that fails without the fix and name it with the regression commit, for example
`(regression <hash>)`. When you fix a bug that has an `it.todo(...)`, replace the todo with a real
test. Put tests in the file that matches the layer you changed: `test/syncClient.test.mts` (API
client), `test/events.test.mts` (parsing, purges, new-event detection), `test/device.test.mts`
(grinder polling, capabilities, triggers, errors, and the shared `lib/SyncDevice.mts`),
`test/driver.test.mts` (grinder pairing, repair, condition, and the shared `lib/SyncDriver.mts`),
`test/scale.test.mts` (the Sync Scale device and driver), `test/summary.test.mts` (the widget's
24-hour list and grind/shot matching), `test/widget.test.mts` (widget API and grinder picker),
`test/manifest.test.mts` (compose files, translations, versions). Only change existing assertions
when the behaviour change is intended, and say so in the commit. See docs/testing.md.

Fixtures in `test/fixtures/` are real responses from the official app's traffic with every
identifier replaced by a fake one (`GRINDER-1`, `SCALE-1`, …). Keep it that way: never commit a
real serial, device id, e-mail or token.

## Outstanding work

**`TODO.md` (repo root) is the single source of truth for what's left to do.** Check it at the
start of each session. Finished items are archived with their full context (root causes, gotchas,
verification notes) in `COMPLETED.md`. Check there before re-investigating anything that sounds
familiar.

When you find a bug or loose end that you're not fixing right now, add it to `TODO.md`. When you
finish an item, move it to `COMPLETED.md` in the same change. The "Known issues" sections in
`docs/` describe current behaviour; `TODO.md` tracks the fix. Update both.

## Reference docs

- `docs/sync-api.md`: the Mahlkönig Sync cloud API: authentication, the mobile API endpoints and
  record shapes, units, what was verified how (Live / App / Client / Code), and open questions.
  Read it before touching `lib/SyncClient.mts`.
- `docs/requirements.md`: what the app must do, including the maintainer's decisions.
- `docs/device.md`: the `e64ws` device: pairing, the poll cycle, tracker state, capabilities,
  settings, error handling (also the shared poll loop and pairing).
- `docs/scale.md`: the `sync-scale` device.
- `docs/widget.md`: the Espresso dashboard widget: the 24-hour list, grind/shot matching, API,
  refresh, layout.
- `docs/flow-cards.md`: the flow cards, their tokens and when they fire.
- `docs/testing.md`: test setup, fakes, fixtures and conventions.
- `docs/history.md`: how the API was found, and deliberate decisions not to revisit.

**Every change must update `docs/`.** In the same change as the code, update the affected
`docs/*.md`. If the change introduces an area that no existing file covers, create a new
`docs/<topic>.md` and add it to the list above. Docs describe current behaviour, not history
(history goes in `.homeychangelog.json`). A change is not done until the docs match the code.

## User-facing docs: keep them in sync with feature changes

The files below describe the app to end users. They **must be updated whenever a user-visible
feature changes** (a new flow card or token, capability, device setting, supported grinder,
changed timing or purge behaviour):

- `README.md` is the full GitHub-facing doc (installation, every value, card, token and setting,
  limitations, disclaimer, credits). `docs/` is the developer reference; README.md is the
  user-facing explanation.
- `README.txt` is the Homey App Store description, and `README.nl.txt` is its translation. Plain
  text, no markdown, non-technical, and consistent with README.md. **Keep it very short: two
  paragraphs on the core value proposition, then the closing community/GitHub pointer.** Do NOT
  grow it into feature lists: no per-card breakdowns, settings detail, requirements or how-to
  steps. All of that belongs in README.md. App Store Guidelines 1.3 reject descriptions that
  accumulate those sections. When a new feature lands, update README.md and leave the README*.txt
  files alone unless the core pitch itself changed. If it did, update both languages together.

The README must keep the disclaimer that the app is not made by Mahlkönig, and the credit to the
Home Assistant integration.

When finishing a feature, check both before committing.

## Homey Compose: never edit `app.json` directly

`app.json` is generated by `homey app build` from:

- `.homeycompose/app.json` (id, version, name, images, contributors)
- `.homeycompose/capabilities/*.json` (all custom capabilities, including the Sync Scale ones the
  device adds at runtime, and `disc_usage` / `disc_health`, which no driver lists but which must
  stay defined so existing devices can have them removed: never delete a capability definition
  that a migration removes)
- `drivers/<id>/driver.compose.json` (class, capabilities, pairing and repair views), for `e64ws`
  and `sync-scale`
- `drivers/<id>/driver.settings.compose.json` (device settings and read-only labels)
- `drivers/<id>/driver.flow.compose.json` (all flow cards: they are device cards, so the device
  argument is added automatically; there is no `.homeycompose/flow/`). Card ids are app-wide:
  the scale's trigger is `scale_shot_completed`.
- `widgets/espresso/widget.compose.json` (widget settings and api routes; previews and
  `public/index.html` next to it)

## Architecture

- **`lib/SyncClient.mts`** is the only code that talks to the cloud and has no Homey imports.
  It owns the session: login with e-mail/password, refresh with the refresh token shortly before
  the 600 s access token expires, a fresh login when the refresh fails, and one re-login plus retry
  when a request gets 401/403. Concurrent callers share one login. Errors are `SyncAuthError`
  (credentials rejected) or `SyncApiError` (network, HTTP or parse failure). It never logs.
- **`lib/events.mts`** is pure: it converts raw events (mg → g, ms → s, `deviceDate` as the
  time), decides purges (dose below the threshold), pairs a shot with the grind before it, and
  decides which events are new (`ingestGrinds` / `ingestBrews` over a `TrackerState`).
- **`lib/SyncDevice.mts`** / **`lib/SyncDriver.mts`** are the base classes both drivers extend:
  the client from the stored credentials, the poll loop with `homey.setTimeout`, exponential
  backoff, availability, repair, pairing (`login_credentials` → `list_devices`), and helpers.
  Subclasses implement `poll()` and `listDevices()`.
- **`drivers/e64ws/device.mts`** polls the grinder: every poll asks for
  the grinder's grind events (and the scale's brew events) of the last 24 hours,
  feeds them through `events.mts`, **persists the tracker state in the device store before firing
  triggers**, then updates capabilities and fires the cards. The status block (standby,
  temperature, firmware, paired scale) is refreshed every 10 minutes.
- **`drivers/e64ws/driver.mts`** lists the account's grinders and registers the condition's run
  listener.
- **`drivers/sync-scale/`** lists the account's scales and polls one scale's brew events: yield,
  shot time and `scale_shot_completed`. No dose or ratio (those stay on the grinder, which also
  keeps its own shot capabilities and card: a shot fires on both devices, on purpose).
- **`widgets/espresso/`** lists the last 24 hours (grinds and shots, matched by time) from the
  grinder device's stored state through `widgetTimeline()` (`lib/summary.mts`, pure) and never
  calls the cloud. The grinder emits `espresso.updated` after
  a poll that changed something; `app.mts` registers the widget's grinder picker.
- Credentials live in the device store (`email`, `password`) and are never logged. Tokens live only
  in memory.

### Purges and "new" events

- The cloud records every grind, purges included, as a separate event with its own `eventUuid`.
- A purge is a grind whose dose is below the `purge_threshold` setting (default 5 g). Purges fire
  "Grind completed" with `is_purge: true`, but never change the capabilities or the condition:
  those always reflect the last real grind.
- The first poll after pairing only sets a baseline. Events first seen more than 60 minutes after
  they happened update the device but don't fire triggers.

## Translations

Supported languages: English (`en`) and Dutch (`nl`), from `locales/`. User-facing strings live in
`locales/*.json` (errors, pairing messages, labels) and in every compose file
(`.homeycompose/**`, `drivers/**/driver*.compose.json`). Update all languages in the same change;
`test/manifest.test.mts` fails on a missing translation or a locale key that exists in one language
only. The `homey-translate` skill covers adding a language.

## Releasing

**Every publication needs a new version number.** The version lives in **three** places, and all
three must be bumped together:

1. `.homeycompose/app.json` is the source of truth. Everything else follows it.
2. `app.json` is generated. Refresh it with `homey app build` after step 1 and commit the
   regenerated file.
3. `package.json` is **purely cosmetic, so keep it in sync.** Nothing reads it: the Homey CLI only
   uses the dependency list, and no app code reads a version. Update it with
   `npm version <x.y.z> --no-git-tag-version`, which also updates the root of `package-lock.json`.
   Never run plain `npm version`, which also creates a commit and a git tag.
   `test/manifest.test.mts` checks that the three match.

Then add the release's entry to `.homeychangelog.json` (en and nl). Use user-facing wording that
describes what changed for the user, not the commit subjects, and skip anything that only touches
docs. Run `homey app validate --level publish` before committing.

Workflows in `.github/workflows/`:

- `homey-app-validate.yml` runs on every push and PR: `npm install`, `npm run lint`, `npm test`,
  then `homey app validate --level verified`. It also auto-merges Dependabot PRs that pass.
- `homey-app-version.yml` (manual, inputs `version` = major/minor/patch and `changelog`) bumps the
  version with `athombv/github-action-homey-app-version` (after lint and test), syncs `package.json` with
  `npm version … --no-git-tag-version`, commits, tags and creates a GitHub release.
- `homey-app-publish.yml` (manual) runs `npm install`, lint and test, and publishes with
  `athombv/github-action-homey-app-publish` (needs the `HOMEY_PAT` secret). Publishing is a
  separate run from the version bump.

Each published version stands on its own. `homey app publish` uploads it as a **test** version
that is reachable only by its own link, and **certifying it promotes that version to live**,
auto-updating every existing install. The standing plan is to certify every publication, so treat a
publish as "this is going to all users shortly" rather than as a private build. Publishing never
overwrites anything: an older version is superseded only when a newer one is certified.
