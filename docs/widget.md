# The Espresso widget

Files: `widgets/espresso/widget.compose.json`, `widgets/espresso/api.mts`,
`widgets/espresso/public/index.html`, `widgets/espresso/preview-{light,dark}.png`. The data comes
from `lib/summary.mts` (`buildTimeline`) via `E64WSDevice.widgetTimeline()`; the grinder picker is
registered in `app.mts`.

The widget looks like the official Sync app's history: a timeline of the **latest grinds and Sync
Scale shots** (1, 3, 5 or 10, newest first), every grind (purges included) and every shot, with each
shot matched to the grind it belongs to. It never calls the cloud: it reads what the grinder device
stored during its polls.

## Settings

| Id | Type | |
|---|---|---|
| `device` | autocomplete | The E64 WS device to show. Options come from `app.mts`: every device of the `e64ws` driver, `{ name, id: data.id }`, filtered by name, sorted. |
| `count` | dropdown `1` / `3` / `5` / `10`, default `5` | How many entries (a matched grind + shot counts as one). With `1` the timeline rail and dot are hidden (class `single` on the container); the time stays. |

## API

| Route | Handler | Query | Returns |
|---|---|---|---|
| `GET /timeline` | `getTimeline` | `device` (the device's `data.id`), `count` (1, 3, 5 or 10; anything else → 5) | `TimelineEntry[]` from `lib/summary.mts`. Throws `widget.noDevice` when no E64 WS device has that id. |

## Matching (`buildTimeline`)

- All stored grinds and shots (`recentGrinds` / `recentBrews` plus the last ones), unique by id.
- A shot is joined to the grind the cloud links it to (`payload.grindEventUuid`, via
  `linkedGrind`). Never by time: a shot without a link, or whose grind isn't stored, is listed on
  its own.
- Every grind becomes an entry (with its shot if matched); every unmatched shot becomes an entry
  of its own. Entries are sorted newest first and cut to `count`; a matched entry has the grind's
  time.
- Per grind: `deviationG` = weight − recipe target (null without a target or weight). Per joined
  shot: `deviationS` = the grind's `brewTimeRecipe` − brew time (the official app's sign: −3.0 s for
  28.0 s against 25 s), and `ratio` = brew weight ÷ grind weight, one decimal (null when unknown).
- `quality` (`good` / `ok` / `bad`) colours each deviation green / orange / red: the cloud's
  `shotQuality` (`PERFECT` / `OK` / other) when the shot has one, else the ±5 / ±10 % bands of
  `recipe-threshold` (`qualityOf`).

| Entry | Shows |
|---|---|
| Grind + shot | An "E64 WS" card (grind weight with its deviation, disc distance in µm) and a "Sync Scale" card (brew weight, brew time with its deviation) joined by a link badge, then "Brew ratio 1:x" ("1: -" when unknown) |
| Grind only (purges too) | The "E64 WS" card |
| Shot only | The "Sync Scale" card |

The grinder's tracker state keeps `recentGrinds` / `recentBrews`, filled from every poll's full
24-hour read (`docs/device.md`); the last real grind and the last shot are added too.

## Refreshing

After a poll in which anything changed (new grinds or shots in the window, or a status refresh),
the grinder device emits the realtime event `espresso.updated` with `{ deviceId }`. The widget
reloads when the id is its own grinder.

## Page

Static HTML with inline JS; Homey widget CSS variables and text classes. Values only go into the
DOM through `textContent`. Strings are `widget.*` keys in `locales/*.json`. Times are the viewing
device's local time; entries from yesterday get the weekday in front.

- **Height**: `Homey.ready()` is called first (Homey ignores `setHeight` before it), then a
  `ResizeObserver` on the container calls `Homey.setHeight(container height + body padding)`
  whenever the content changes. Don't measure `body.scrollHeight`: the body can be stretched to
  the iframe's height, and the widget would never shrink.
- **Layout**: no padding of its own (the `homey-widget` body class has it). A vertical rail with a
  dot and the time per entry; translucent cards (`rgba(127,127,127,.12)`, readable in light and
  dark); the link badge is a constant inline SVG (the only `innerHTML`, never data). Deviation
  colours: `--homey-color-green` / `-orange` / `-red` with fallbacks.

## Known issues


- The official app showed the 2026-10-02 13:31 shot's −3.0 s in red, where the cloud's verdict was
  `OK` (orange here). Its exact colour rule is unknown.
- Shots only appear when the grinder has a paired Sync Scale (the grinder device reads its scale's
  shots); the separate Sync Scale device isn't used by the widget.
