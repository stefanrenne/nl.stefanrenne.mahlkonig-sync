# Testing

Vitest runs the `.mts` sources directly. `npm test` first type-checks the tests
(`tsc -p test/tsconfig.json`), then runs `vitest run`.

## Setup

| File | Role |
|---|---|
| `vitest.config.mjs` | Aliases `homey` (only exists inside the Homey runtime) to `test/mocks/homey.mts`. |
| `test/mocks/homey.mts` | `App`, `Device`, `Driver` stand-ins. The `Device` keeps capabilities, values, settings, store (JSON-copied like Homey's) and availability in plain fields, and records `error()` calls in `errors`. `setCapabilityValue` throws for a capability the device doesn't have. |
| `test/helpers/fake-homey.mts` | `createFakeHomey()`: flow cards (`FakeCard` with a `trigger` spy, `tokens()` and `run()`), `__` returning the key (plus placeholders as JSON), `i18n.getLanguage() = 'en'`, `clock.getTimezone() = 'Europe/Amsterdam'`, `setTimeout`/`clearTimeout` spies. Loads the real generated `app.json` as `manifest`. |
| `test/fixtures/*.json` | Real responses from the official app (grind events with the maintainer's purge and 20 g shot, last events, device record, scale binding, scale list), with every identifier replaced by a fake one. |
| `test/tsconfig.json` | Extends the root config with `noEmit` and `rootDir: ".."`, and re-declares `exclude` (the root excludes `test/`). |
| `.homeyignore` | Keeps `test/`, `scripts/`, `docs/`, `probe-output/` and the configs out of the app bundle. |

## Test files

| File | Covers |
|---|---|
| `test/syncClient.test.mts` | Login (request shape, 400/401/403 → `SyncAuthError`, missing token, network and server errors, no password in errors), token reuse, refresh before expiry with the non-rotating refresh token, re-login when refresh fails, one retry on 401, giving up on a second 403, one shared login for concurrent calls, and the request/response shape of every data endpoint. Uses a routed fake `fetch` and an injected clock. |
| `test/events.test.mts` | Parsing and unit conversion, device vs cloud date, "0 means no target", purge rule and threshold, ratio, dose pairing window, the baseline, overlap dedupe, ordering, purge-after-shot, the bounded seen-list, and shots. |
| `test/device.test.mts` | The device with a fake client: baseline poll, capabilities, status and scale capabilities, label settings, poll windows, trigger tokens (including `is_purge` and `started_via`), no repeats across restarts, the 60-minute age limit, shot tokens, unavailable + exponential backoff + recovery, auth message, status failures not blocking grinds, no password in logs, settings changes, repair, deletion, and the condition. |
| `test/driver.test.mts` | Grinder pairing (login validation, device list with credentials in the store, rejected vs unreachable, no grinders), repair (updates credentials, refuses another account), the condition's run listener, `deviceName`. Covers the shared `lib/SyncDriver.mts`. |
| `test/scale.test.mts` | The Sync Scale: capabilities (no dose/ratio), baseline, poll window, trigger tokens and order, age limit, restarts, errors; pairing with serial and paired-grinder labels, no scales, repair. |
| `test/manifest.test.mts` | Every compose file translated into every locale, no empty args/tokens (including driver flow cards), `app.json` matches the compose card ids, every driver capability is defined, the runtime scale capabilities exist, every image exists, locale keys match, a README per language, versions in sync, a changelog entry for the current version. |

## Conventions

- Time: `vi.useFakeTimers({ toFake: ['Date'] })` with `vi.setSystemTime(...)`; the device never
  waits on real timers because `homey.setTimeout` is a spy and tests call `tick()` / `poll()`.
- Devices and drivers are subclassed in the test to override `createClient()` and constructed via
  `as unknown as new (...) => Harness`, because the Homey types don't declare a constructor.
- Assert on translation keys (`errors.auth`, `pair.unreachable`), not on English text.
- Known bugs get an `it.todo` with a pointer to TODO.md; a fix replaces it with a real test.
- Regression tests are named `(regression <hash>)`.
