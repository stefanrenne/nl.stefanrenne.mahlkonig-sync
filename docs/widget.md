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
- Shots are matched oldest first: each takes the **newest grind at most 15 minutes before it**
  (`MAX_GRIND_TO_SHOT_MS`) that no other shot took. A grind after the shot never matches.
- Every grind becomes an entry (with its shot if matched); every unmatched shot becomes an entry
  of its own. Entries are sorted newest first and cut to `count`; a matched entry has the grind's
  time.
- Per grind: `deviationG` = weight − recipe target (null without a target). Per matched pair:
  `ratio` = brew weight ÷ grind weight, one decimal, null when the grind weighed 0 g.

| Entry | Shows |
|---|---|
| Grind + shot | An "E64 WS" card (grind weight with its deviation, disc distance in µm) and a "Sync Scale" card (brew weight, brew time) joined by a link badge, then "Brew ratio 1:x" ("1: -" when unknown) |
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
  colour: green within 5 % of the target, red outside (assumed from the recipe threshold bands
  ±5/±10 %; the official app's exact rule is unknown).

## Known issues

- No deviation on the brew time: the official app shows one (e.g. −3.0 s at 28.0 s), but its target
  doesn't match the recipe's `brewTimeRecipe` (25 s would give +3.0 s). See TODO.md.

- Matching is by time only (the cloud gives no link between a grind and a shot). Two grinds and
  two shots close together can be paired differently from the official app.
- Shots only appear when the grinder has a paired Sync Scale (the grinder device reads its scale's
  shots); the separate Sync Scale device isn't used by the widget.
