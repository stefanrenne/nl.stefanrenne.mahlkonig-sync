# Mahlkönig Sync cloud API

The Mahlkönig E64 WS has no local API. It reports to the Mahlkönig Sync cloud, and the
official web dashboard on `sync.mahlkoenig.com` reads the data back through an
**undocumented** HTTP API. This file records what is known about that API.

## Source and confidence

> **Summary (2026-10-02):** the app should use the **mobile API** (`/api/mobile-service/…`),
> the one the official Sync iOS/Android app uses. It works for home accounts, which have no
> store and are refused by the web dashboards and by the shot-history query the HA integration
> uses. See [Mobile API](#mobile-api). The web-dashboard sections further down stay as
> background.

Four sources:

1. The community Home Assistant integration
   [tomereli/ha-mahlkoenig-sync](https://github.com/tomereli/ha-mahlkoenig-sync) at commit
   `ce2ec91` (2026-08-30, integration version 0.1.1). Its author says the endpoints were
   "discovered from the Sync web dashboard's own traffic" (`const.py`).
2. The official web clients' public JavaScript, read on 2026-10-01: the admin dashboard
   (`admin.sync.mahlkoenig.com`, an Angular app; endpoint paths in its `config.base.json`) and the
   chart dashboard (`chart.sync.mahlkoenig.com`, a Flutter app, `main.dart.js`).
   `https://sync.mahlkoenig.com/app/` redirects to the admin dashboard.
3. `scripts/probe.mjs` run against the live API with the maintainer's account (a home
   account: E64 WS plus Sync Scale) on 2026-10-01 and 2026-10-02 (then still the web-dashboard
   probe). Since 2026-10-07 the script probes the mobile API and runs the app's `SyncClient`; run
   `node scripts/probe.mjs [--bad-login]` to check the open questions below. The reports are in the
   gitignored `probe-output/`.
4. The official Sync iOS app's traffic, captured by the maintainer with mitmproxy in WireGuard
   mode on 2026-10-02 and redacted with `scripts/capture.py`. The app is Flutter
   (`User-Agent: Dart/3.10 (dart:io)`) and ignores the phone's HTTP proxy, which is why a
   proxy like Charles only shows `socket://`; WireGuard mode captures it. No certificate
   pinning. No WebSocket traffic was seen: the app polls over HTTPS.

Each statement has one of four confidence levels:

- **Live**: seen in a real response from the probe.
- **App**: seen in the official mobile app's captured traffic.
- **Client**: the official dashboard code sends or reads this.
- **Code**: the HA integration sends or reads this. It works for at least one user
  (the author's E64 WS plus Sync Scale).
- **Inferred**: follows from how the HA code treats a value (for example dividing by 1000),
  but is not stated anywhere.
- **Open**: unknown. Listed under [Open questions](#open-questions) and not to be built on
  until verified.

Upstream file references are relative to `custom_components/mahlkoenig_sync/`.

### License

The upstream repo is **MIT-licensed** (© 2026 Tomer Arbel Eliyahu). MIT allows copying with
the copyright notice kept. This app is a TypeScript reimplementation of the behaviour, not a
port of the Python code. Endpoint paths and field names are interface facts. We still credit
the upstream project in `README.md`.

## Base URL

```
https://sync.mahlkoenig.com
```

(Code, `const.py:7`)

## Authentication

### Login

```
POST /api/security-service/auth/token
Content-Type: application/json

{ "username": "<account e-mail>", "password": "<password>" }
```

(Code, `api.py:_login`)

- The e-mail goes in a field called `username`.
- **Response status handling in HA:** `400`, `401` and `403` are treated as "credentials
  rejected". Any other non-2xx is a generic error. (Code. What a wrong password actually
  returns is **open**, Q1; the probe can test it with `--bad-login`.)
- **Response body** (Live; field names also match the admin dashboard's session class):

  ```json
  {
    "access_token": "<JWT, HS256, ~630 chars>",
    "refresh_token": "<opaque, ~500 chars>",
    "token_type": "Bearer",
    "expires_in": 599222,
    "access_expires": "2026-10-01T18:47:51.000Z",
    "refresh_expires": "2026-10-10T02:37:51.000Z",
    "scope": ["ROLE_COMP_CHART_R", "ROLE_USER", "…10 roles"],
    "username": "<account e-mail>",
    "details": {
      "comp": 10001,
      "userId": "<6 chars>",
      "orgId": "ngx",
      "defaultOrgId": "ngx",
      "organisationIds": ["ngx"],
      "groupContexts": [{ "orgId": "ngx", "userId": "<6 chars>", "groups": ["USERS", "FAM_ADMINS"] }]
    }
  }
  ```

  - The token is in `access_token`. HA's fallback list of other key names isn't needed.
  - `expires_in` is in **milliseconds** (Client: the admin dashboard computes
    `Date.now() + expires_in`). It's a little under 600 000, presumably time already used
    on the server.
  - The JWT has `iat` and `exp` exactly **600 s** apart (Live).
  - `access_expires` / `refresh_expires` are ISO-8601 UTC strings. The refresh token lived
    about 8 days 8 hours in the one sample (Live).
  - `details.comp` is the account's **company id** (Inferred from the `ROLE_COMP_*` roles and
    from it being the value the dashboards query stores and devices by; see [Store ID and company ID](#store-id-and-company-id)).
  - `orgId` `"ngx"` is the platform ("Hemro NGX" in the admin dashboard's `config.json`), not
    the user's company.
  - There's no store id anywhere in the login response or the JWT (Live).

### Using the token

Data requests send:

```
authorization: Bearer <access_token>
```

(Code, Client)

### Lifetime and refresh

- Access tokens live **600 s** (Live: JWT `exp − iat`).
- The admin dashboard refreshes with (Client):

  ```
  GET /api/security-service/auth/refresh
  Authorization: Bearer <refresh_token>
  ```

  It merges the response into its session object. The response (Live) has the login
  response's fields **except** `refresh_token` and `refresh_expires`: the refresh token does
  not rotate. Called with 8 minutes left on the access token, it returned the **same**
  `access_token` with a new `access_expires`. Whether the access token keeps working after a
  refresh is **open** (the 2026-10-02 run tested it with a query that was refused for another
  reason, see Q8).
- The admin dashboard treats a token as expired a little early (a `BUFFER` constant, value not
  checked) and also checks `refresh_expires`.
- HA never uses the refresh token. It logs in again with e-mail and password when either
  480 s have passed since the last login (`TOKEN_TTL`, `const.py:16`), or a data request
  returns `401`/`403` (it then logs in again **once** and retries). With a 2-minute poll that
  is about 180 logins a day per account. Refreshing would avoid sending the password that often.

## Mobile API

All under `https://sync.mahlkoenig.com/api/mobile-service/`, authenticated with the same
`authorization: Bearer <access_token>` from the same login and refresh endpoints (App). The app
sends no other custom headers: `user-agent`, `content-type: application/json`,
`accept-encoding: gzip`. Bodies are JSON; `null` fields are sent explicitly but are presumably
optional. Everything below is App unless marked otherwise.

### Endpoints the app uses

| Method and path | Body / query | Returns |
|---|---|---|
| `POST stats/event/last-events` | `{ "limitToCurrentDevice": true }` | `{ lastGrind, lastBrew }`: the newest grind event and the newest brew (scale) event. The app only uses it as a pairing fallback (see How the app polls). |
| `POST grind-event/find` | `{ deviceDateRange: { from, to }, orderBy: "deviceDate", orderDir: "DESC", loadDevice: true, deviceIds: ["<grinder deviceId>"], storeIds2: null, storeIds: null, regionIds: null, companyIds: null }` | Bare array of grind events in the range. No pager was sent and none came back. |
| `POST device-event/brew-event/find` | Same shape, with the scale's id in `deviceIds` | Bare array of brew events |
| `GET device/?key=<deviceId>` | | The device record, including the `status` block (see [Store ID and company ID](#store-id-and-company-id) for its shape) |
| `POST device-union/query` | `{ deviceClasses: ["SCALE"], loadBindings: true, loadStore: true, excludeTypes: ["xenia"], orderBy: "change.date", orderDir: "DESC", …nulls }` | `{ stamp, rows, items }`: the account's devices of that class with their bindings. Each item has `deviceId`, `deviceType` (`BREWER`/`GRINDER`), `deviceClass` (`SCALE`/`GRINDER`), `serial`, `type`. The app only asked for scales; asking for `GRINDER` is untested. |
| `POST brewer-binding/query` | `{ grinderId, brewerId: null, loadDevice: true, orderDir: "DESC" }` | `{ stamp, rows, items }`: the scale paired with a grinder |
| `GET grind-event/count/total?deviceId=<id>` | | Plain number: total grinds ever |
| `POST stats/device/analytics` | `{ chartName: "eventsTotal", grindDays: { from, to }, deviceIds: [grinder, scale], header: true, aggregate: false, drillDown: false, …nulls }` | `{ chartType: "kpiCard", values: { totalGrindEvents, totalBrewEvents, shotsOnTarget, groundCoffee } }` (`groundCoffee` in kg, inferred: 0.022 for two grinds of 1.6 g and 20 g) |
| `POST cloud-recipe/query` | `{ status: ["PUBLISHED"], orderBy: "change.date", orderDir: "DESC", …nulls }` | `{ stamp, rows, items }`: the account's recipes with name, bean, `mode`, `grindWeight` (mg), `coarseness`, `brewWeight` (mg), `brewTime` (ms), `brewRatio`, `brewTemperature` |
| `GET recipe-threshold/?key` | | `{ brewTime, grindTime, grindWeight }`, each `[-10, -5, 5, 10]`: the % bands for "on target" |
| `POST grinder-model/find` | `{ orderBy: "name" }` | Grinder models with `modelId`, `slots`, `hasScale`, `dddMax` (400 for the E64 WS) and `weightCalcFactors` |
| `GET profile/my-profile` | | `{ profileId, company: { companyId, type: "FAM", info.name }, user: {…}, managedStores: null, … }` |
| `GET settings/app-config`, `settings/app-version`, `notification/unreadCount`, `PUT push-token/add` | | App housekeeping; not needed |
| `POST /api//mobile-service/scale/chart/pool` (sic, double slash) | `{ deviceId }` or no body | Always 400/401 in the capture; unclear |

`deviceDateRange` / `grindDays` in the app are the local calendar day expressed in UTC
(`2026-10-01T22:00:00.000Z` … `2026-10-02T21:59:59.999Z` for 2 October in Amsterdam).

`limitToCurrentDevice` has no device id next to it, so the server decides which device is
"current" (presumably the account's grinder). With one grinder that doesn't matter; with
several it's **open** (Q9).

### Grind event

From `grind-event/find` and `last-events.lastGrind`:

```json
{
  "eventUuid": "00000000-…",
  "name": "<recipe or event name>",
  "deviceId": "<grinder>", "companyId": "<company>",
  "cloudDate": "2026-10-02T06:59:43.762260Z",
  "deviceDate": "2026-10-02T06:59:43.611Z",
  "localDate": "2026-10-02T08:59:43.611",
  "payload": {
    "recipeIndex": 0, "recipeUuid": "00000000-…", "recipeMode": "Gbw",
    "recipeType": "DoubleShot", "recipeIcon": "DoubleCup", "filterType": "DOUBLE",
    "recipeM2mLinked": false,
    "durationActual": 7926, "durationRecipe": 0, "durationNoLoad": 0,
    "weightActual": 19976, "weightRecipe": 20000,
    "dddActual": 139, "dddRecipe": 140,
    "sizeTheoretic": 69, "sizeRecipe": 70,
    "brewTimeRecipe": 25000,
    "triggerMode": "PortafilterDetection",
    "successful": true
  },
  "device": { "…the device record without status…" }
}
```

- **Every grind is its own event, with or without a shot** (answers Q4). The maintainer's purge
  of 2026-10-02 is there: `durationActual` 1432, `weightActual` 1637, `triggerMode`
  `"StartButton"`. The 20 g shot right after it: 7926 / 19976, `"PortafilterDetection"`.
- `weightActual: 0` means the grind wasn't weighed (2026-10-02 13:31: 0.0 g against a 20 g target,
  followed by a 42.5 g shot; the official app shows it with a −20 g shortfall). The app treats it as
  an unknown dose.
- `weightActual` / `weightRecipe` in **mg**, `duration*` and `brewTimeRecipe` in **ms**
  (consistent with the HA conversions and with the purge/shot values).
- `deviceDate` is the grinder's clock (UTC, ms), `cloudDate` the cloud's receipt (UTC, µs),
  `localDate` the device's local time without a zone. For "last grind" use `deviceDate`.
- Values seen: `recipeMode` `"Gbw"` (grind by weight), `triggerMode` `"StartButton"` /
  `"PortafilterDetection"`, `filterType` `"DOUBLE"`, `recipeType` `"DoubleShot"`,
  `recipeIcon` `"DoubleCup"`. Other values are **open** (Q6).
- `dddActual` / `dddRecipe`: the disc distance in µm, 139 vs 140 (the official app labels it
  "Disc distance … µm"); the model's `dddMax` is 400 and recipes call it `coarseness`.
- `sizeTheoretic` / `sizeRecipe` (69 / 70): meaning **open**.

### Brew event (Sync Scale)

From `device-event/brew-event/find` (Live, probe 2026-10-07: 9 shots in 7 days):

```json
{
  "eventUuid": "…", "name": "…",
  "deviceId": "<scale>", "companyId": "<company>",
  "cloudDate": "2026-10-02T12:40:14.288392Z", "deviceDate": "2026-10-02T12:40:14.288392Z",
  "localDate": "2026-10-02T14:40:14.288392",
  "payload": {
    "duration": 28000, "mass": 42500, "stopType": "AutoTimerFlow", "brewer": "scale",
    "grindEventUuid": "<eventUuid of the grind>", "grinderId": "<grinder>"
  },
  "shotQuality": { "overall": "OK", "brewTime": "OK", "grindWeight": "PERFECT" },
  "device": null
}
```

- `mass` in mg, `duration` in ms (as in the HA mapping).
- **`payload.grindEventUuid` links the shot to its grind** (and `payload.grinderId` to the
  grinder): this is how the official app joins a grind and a shot. Present on the shots that had a
  grind before them (7 of 9); missing on scale-only shots (Q12).
- `shotQuality` (on matched shots): `overall`, `brewTime`, `grindWeight`; values seen `"PERFECT"`
  and `"OK"`. Presumably from the recipe threshold bands (`recipe-threshold`: ±5 / ±10 %).
- For the scale `deviceDate` equals `cloudDate` (no own clock); `localDate` is local time.
- `stopType`: only `"AutoTimerFlow"` seen (9 of 9). The older `last-events.lastBrew` sample had
  no `grindEventUuid` or `shotQuality`.
- The official app shows the brew time deviation as **target − actual** (−3.0 s for a 28.0 s shot
  with `brewTimeRecipe` 25 s), the opposite sign of the grind weight deviation (actual − target).

### How the app polls

Implemented in `drivers/e64ws/device.mts` (details in `docs/device.md`):

1. Log in once; keep `access_token` and `refresh_token` in memory. Refresh shortly before the
   access token expires (600 s); log in again when the refresh fails.
2. Every poll (default 2 minutes): `POST grind-event/find` for the grinder's `deviceId`, from just
   before the newest grind already seen (at most 24 h back). New `eventUuid`s fire "Grind
   completed". This catches every grind, also when a purge follows a shot within one interval,
   which `last-events` (newest grind only) would hide. It also doesn't depend on which device
   `limitToCurrentDevice` picks.
3. With a paired scale: `POST device-event/brew-event/find` for the scale, the same way, for
   "Shot completed".
4. At most every 10 minutes: `GET device/?key=<grinder>` for the status block and
   `POST brewer-binding/query` for the paired scale.

So a normal poll is one or two requests.

## Store ID and company ID

- The shot-history query needs `storeId` **or** `companyId`. The chart dashboard builds the
  body with `storeId` if it has one, `companyId` if it has one, or both (Client, `main.dart.js`).
  Neither gives `400 BAD_REQUEST` / `java.lang.IllegalArgumentException` (Live).
- In the Sync ecosystem a company owns stores (locations), and grinders can be registered to a
  store. **A home account has no store** (Live): `store/query-managed` returns 0 items and the
  grinder record has no `storeId`. The roles include `ROLE_FAM_ADMIN` / `ROLE_FAM_ONB`, which
  look like a "family" (home) account type. The HA author's account did have a store.
- **The shot-history query refuses every scope a home account has** (Live, 2026-10-02):
  `companyId` → `403` (empty body), `companyId` + `grinderId` (the grinder's `deviceId`, as
  number or string) → `403`, `grinderId` alone → `400 IllegalArgumentException`, `companyId`
  as a string → `403`. So the endpoint needs a `storeId` (or a role this account lacks), and the
  HA integration's approach does **not** work for a home account without a store. How the
  official clients show a home user's shot history is **open** (Q8).
- **The company id is in the login response** (`details.comp`, Live). With it, the user
  doesn't have to look up a Store ID in the browser's network tab, which is what HA asks for.
  Whether the shot-history query with only `companyId` really returns data is **open** (Q8),
  but it's what the official chart app does.
- The admin dashboard lists the stores of a company with (Client):

  ```
  POST /api/admin-service/store/query-managed
  { "companyId": 10001, "orderBy": "info.name", "orderDir": "ASC", "loadRegion": true,
    "pager": { "firstResult": 0, "pageSize": 20 } }
  ```

  The response is `{ items: [...], hasMore }` with items carrying at least `storeId`,
  `companyId`, `info.name` and (with `loadRegion`) `region.info.name` (Client).
- Grinders and other devices are listed with `POST /api/admin-service/device/query` and a
  similar body (`companyId`, `storeId`, `pager`, `loadStore`, `loadStatus`, `loadBindings`;
  Client). Device records have at least `deviceId`, `companyId`, `storeId`, `name`, `type`,
  `subType`, `testDevice`, `fixedFirmware`, `productionDate`, `assemblyDate`, `created`,
  `change` (Client, chart app's device parser). This gives the pairing step a real device list
  (Q9). **A home account may call it** (Live). Its grinder record looks like this (identifiers
  replaced):

  ```json
  {
    "deviceId": "<id>", "serial": "<serial>", "companyId": "<company>",
    "type": "E64WS", "subType": "Espresso", "testDevice": false,
    "productionDate": "2026-04-20T19:17:14Z", "assemblyDate": "2026-05-13T08:35:04Z",
    "hmiHwProductId": "<id>", "bindingCode": "<code>",
    "created": { "user": "<e-mail>", "date": "…" }, "change": { "user": "<e-mail>", "date": "…" },
    "status": {
      "deviceId": "<id>",
      "cloudDate": "2026-10-02T06:55:08.489234Z",
      "deviceDate": "2026-10-02T06:55:08.091Z",
      "status": {
        "standbyActive": true, "motorTemperature": 34, "motorOnTime": 0,
        "discUsageTime": 4, "discHealth": 0, "timeZone": "Europe/Amsterdam",
        "hmiSwVersion": "V01.16-24", "espSwVersion": "V01.11", "bundleVersion": "10160024"
      }
    },
    "bindings": [{
      "grinderId": "<id>", "brewerId": "<scale id>",
      "brewer": { "brewerId": "<scale id>", "serial": "<serial>", "type": "scale", "companyId": "<company>" }
    }],
    "company": null
  }
  ```

  The `status` block (with `loadStatus: true`) is a bonus: standby state, motor temperature,
  disc usage and firmware versions, with both a device and a cloud timestamp. The `bindings`
  (with `loadBindings: true`) show whether a Sync Scale is paired. The envelope is
  `{ stamp, rows, hasMore, items }`. Units of `discUsageTime`, `motorOnTime` and `discHealth`
  are unknown.
- HA's diagnostics redact `storeId`, `companyId` and `regionId`, which suggests these
  identifiers also appear in the shot-history records (Inferred, `diagnostics.py`).

## Data endpoint: shot history

```
POST /api/dashboard-service/shot-history/query
authorization: Bearer <token>
Content-Type: application/json
```

Request body as HA sends it (Code, `api.py:async_get_latest`):

```json
{
  "storeId": 3868,
  "grinderId": null,
  "cloudDate": { "from": "2026-09-24T12:00:00.000Z", "to": null },
  "pager": { "firstResult": 0, "pageSize": 1 },
  "orderBy": "brew.cloudDate",
  "orderDir": "DESC"
}
```

| Field | HA value | Meaning |
|---|---|---|
| `storeId` | integer from setup | Store to query. The chart app sends `companyId` instead or as well (see above). |
| `grinderId` | `null` | Presumably "all grinders in the store" (Inferred). Accepted values are **open** (Q9). |
| `cloudDate.from` | now − 7 days, UTC, `YYYY-MM-DDTHH:mm:ss.000Z` | Lower bound of the time window (`LOOKBACK_DAYS = 7`) |
| `cloudDate.to` | `null` | No upper bound |
| `pager.firstResult` | `0` | Offset |
| `pager.pageSize` | `1` | HA only wants the newest record. The maximum is **open** (Q10). |
| `orderBy` | `"brew.cloudDate"` | Sort key. Note it sorts on the **brew**, not the grind (see Q4). |
| `orderDir` | `"DESC"` | Newest first |

The chart dashboard sends the same shape, with `storeId` and/or `companyId`, and also always
`orderBy: "brew.cloudDate"`, `orderDir: "DESC"` (Client).

**Response:** an object `{ "items": [...], "stamp": "<string>" }` (Client: the chart app reads
`items` and parses `stamp` as a date). HA also accepts a bare array; that isn't needed.
Whether there's paging metadata such as `hasMore` here is **open** (Q3). An empty result (no
records in the last 7 days) means "no data", not an error.

### Record structure (the fields that are known)

The full record has never been published. The upstream commit `fd9254b` added a diagnostics
dump *because* the record carries more than was mapped, but no sample is in the repo. These
are the paths HA reads (Code, `sensor.py`, `diagnostics.py`). Units are Inferred from HA's
conversions.

A record pairs a **grind** event (from the grinder) with a **brew** event (from the Sync Scale):

```
record
├── grind
│   ├── cloudDate              string, ISO-8601 timestamp    → "last grind"
│   ├── deviceId               grinder id (redacted in diagnostics)
│   ├── eventUuid              unique id of the grind event
│   ├── device
│   │   ├── type               model string, used as device model (fallback "E64 WS")
│   │   └── serial             grinder serial number
│   └── payload
│       ├── weightActual       number, milligrams            → dose (g = /1000)
│       ├── weightRecipe       number, milligrams            → dose target
│       ├── dddActual          number, shown by HA as µm      → grind setting
│       ├── dddRecipe          number, µm                    → grind setting target
│       ├── durationActual     number, milliseconds          → grind time (s = /1000)
│       ├── durationRecipe     number, milliseconds          → grind time target
│       ├── brewTimeRecipe     number, milliseconds          → recipe's target brew time
│       ├── recipeMode         unknown type                  → recipe mode
│       ├── recipeIndex        unknown type (number?)        → recipe slot
│       ├── recipeType         unknown
│       ├── filterType         unknown
│       └── successful         unknown (boolean?)
└── brew                       (Sync Scale)
    ├── cloudDate              string, timestamp (sort key of the query)
    ├── payload
    │   ├── mass               number, milligrams            → yield (g = /1000)
    │   └── duration           number, milliseconds          → shot time (s = /1000)
    └── shotQuality
        ├── overall            unknown type                  → Mahlkönig's verdict
        ├── brewTime           unknown type
        └── grindWeight        unknown type
```

Identifiers that HA's diagnostics redact, and that therefore appear somewhere in the record
(exact location unknown): `user`, `name`, `serial`, `storeId`, `companyId`, `regionId`,
`deviceId`, `grinderId`, `brewerId`, `bindingCode`, `hmiHwProductId`.

**Derived value:** HA computes the brew ratio as `brew.payload.mass / grind.payload.weightActual`,
rounded to 2 decimals, only when both are numbers and the dose is non-zero.

HA treats every value as optional: a missing hop in the path gives "unknown", never an error.
We should do the same.

## Grinder vs Sync Scale

| Value | Comes from | Path |
|---|---|---|
| Dose weight, dose target | Grinder | `grind.payload.weightActual` / `weightRecipe` |
| Grind setting, target | Grinder | `grind.payload.dddActual` / `dddRecipe` |
| Grind time, target | Grinder | `grind.payload.durationActual` / `durationRecipe` |
| Target brew time | Grinder (recipe) | `grind.payload.brewTimeRecipe` |
| Recipe mode / index / type, filter type | Grinder | `grind.payload.recipeMode` / `recipeIndex` / `recipeType` / `filterType` |
| Last grind timestamp | Cloud receipt of grind | `grind.cloudDate` |
| Grinder model / serial / id | Grinder | `grind.device.type` / `grind.device.serial` / `grind.deviceId` |
| Yield | Sync Scale | `brew.payload.mass` |
| Shot time | Sync Scale | `brew.payload.duration` |
| Shot quality (overall, brew time, grind weight) | Sync Scale / cloud | `brew.shotQuality.*` |
| Brew ratio | Computed | yield ÷ dose |

## Polling and rate limits

- HA polls every **120 s** ("gentle, ~ what the dashboard does", `const.py:15`).
- Each poll is one query with `pageSize: 1`, plus a login when the token is older than 480 s.
- **No rate limits are documented or handled** by HA (there's no 429 handling and no
  backoff). The login response has no rate-limit headers (Live). Whether the server enforces
  any is **open** (Q10).
- The admin dashboard polls its notifications every 45 s (`notificationIntervalDurationMs`
  in `config.base.json`), so a 2-minute poll is well within what the official client does.
- The upstream README notes: "a grind that isn't yet followed by a brew may lag until its shot
  completes", a consequence of sorting on `brew.cloudDate` (see Q4).

## Mapping to the requested Homey features

Grind values come from `POST grind-event/find`, shot values from `POST device-event/brew-event/find`
(same record shapes as `last-events.lastGrind` / `lastBrew`; see [Mobile API](#mobile-api)).

| Requested | Source | Status |
|---|---|---|
| Dose weight (g) | `payload.weightActual` / 1000 | App |
| Grind setting (disc distance, µm) | `payload.dddActual` | App |
| Grind time (s) | `payload.durationActual` / 1000 | App |
| Last grind timestamp | `deviceDate` | App |
| Yield (g), shot time (s) | brew `payload.mass`, `payload.duration` / 1000 | App; only with Sync Scale |
| Recipe targets | `payload.weightRecipe`, `dddRecipe`, `brewTimeRecipe` | App |
| Recipe mode | `payload.recipeMode` | App; values Q6 |
| Trigger "grind completed" | new grind `eventUuid` | App |
| Trigger "shot completed" | new brew `eventUuid` | App; ratio pairing Q12 |
| Condition "last grind < X min ago" | last real grind's `deviceDate` vs now | App |
| Standby, motor temperature, disc usage/health, firmware | `GET device/?key=<grinder>` → `status.status.*` | App, Live |

## Open questions

Status after the mobile-app capture (2026-10-02). Resolved questions keep their number so
references stay valid.

- **Q1 Login response.** ✅ Token key is `access_token`; a wrong password gives **401 with an empty
  body** (Live, probe 2026-10-07).
- **Q2 Token lifetime and refresh.** ✅ 600 s access tokens, ms `expires_in`, non-rotating
  refresh token, `GET auth/refresh` (Live, App). The app refreshes in normal use (App).
- **Q3 Response envelope.** ✅ Varies per endpoint: bare arrays (`*-event/find`),
  `{ stamp, rows, items }` (queries), plain objects or numbers (App).
- **Q4 Grinds without a brew.** ✅ Every grind is its own event, purges included (App).
- **Q5 Grind setting.** ✅ `dddActual` is the **disc distance in µm**: the official app shows it as
  "Disc distance 139 µm" (App, 2026-10-02 history screen). The recipe calls it `coarseness`.
- **Q6 Enum values.** Mostly answered (Live, 19 grinds and 9 shots over 7 days): `recipeMode`
  `Gbw`; `recipeType` `SingleShot` / `DoubleShot`; `filterType` `DOUBLE`; `triggerMode`
  `PortafilterDetection` / `StartButton`; `successful` `true` / `false` (false once, alongside the
  one unweighed grind); `stopType` `AutoTimerFlow`; `shotQuality.*` `PERFECT` / `OK`. Other
  values (grind by time, other recipes) haven't occurred yet.
- **Q7 Timestamps.** ✅ `deviceDate` (grinder clock, UTC), `cloudDate` (receipt, UTC),
  `localDate` (no zone) (App).
- **Q8 Shot history for a home account.** ✅ Use the mobile API (App). The web-dashboard
  shot-history query refuses home accounts (Live).
- **Q9 Multiple grinders.** Grinders can be listed with `device-union/query`
  `deviceClasses: ["GRINDER"]` as well as `admin-service/device/query`; both work for a home
  account (Live, 2026-10-07). Open: which device `last-events` with `limitToCurrentDevice` picks
  when an account has several (the app doesn't use it for polling).
- **Q10 Rate limits.** Open: none seen. The official app makes about 50 requests when opened.
- **Q11 Dedupe key.** ✅ `eventUuid` is present on every grind and brew event (App).
- **Q12 Grind–brew pairing.** ✅ A shot carries `payload.grindEventUuid` (Live, 2026-10-07); a
  shot without it had no grind (scale only).
- **Q13 Request headers.** ✅ No custom headers needed (Live, App).
- **Q14 Terms of use.** Open. The API is undocumented and may change or be blocked without
  notice. Terms: `https://www.mahlkoenig.com/pages/sync-terms-of-use`.
