# The Espresso widget

Files: `widgets/espresso/widget.compose.json`, `widgets/espresso/api.mts`,
`widgets/espresso/public/index.html`, `widgets/espresso/preview-{light,dark}.png`. The data comes
from `lib/summary.mts` (`buildTimeline`) via `E64WSDevice.widgetTimeline()`; the grinder picker is
registered in `app.mts`.

The widget shows one list of the **last 24 hours**, newest first, like the official Sync app's
history: every grind (purges included) and every Sync Scale shot, with each shot matched to the
grind it belongs to. It never calls the cloud: it reads what the grinder device stored during its
polls.

## Settings

| Id | Type | |
|---|---|---|
| `device` | autocomplete | The E64 WS device to show. Options come from `app.mts`: every device of the `e64ws` driver, `{ name, id: data.id }`, filtered by name, sorted. |

## API

| Route | Handler | Query | Returns |
|---|---|---|---|
| `GET /timeline` | `getTimeline` | `device` (the device's `data.id`) | `TimelineEntry[]` from `lib/summary.mts`. Throws `widget.noDevice` when no E64 WS device has that id. |

## Matching (`buildTimeline`)

- Grinds and shots from the window (now − 24 h … now), unique by id.
- Shots are matched oldest first: each takes the **newest grind at most 15 minutes before it**
  (`MAX_GRIND_TO_SHOT_MS`) that no other shot took. A grind after the shot never matches.
- Every grind becomes an entry (with its shot if matched); every unmatched shot becomes an entry
  of its own. Entries are sorted newest first; a matched entry has the grind's time.

| Entry | Shows |
|---|---|
| Grind + shot | Grind weight, disc distance (µm), brew weight, brew time |
| Grind only (purges too) | Grind weight, disc distance |
| Shot only | Brew weight, brew time |

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
- **Layout**: no padding of its own (the `homey-widget` body class has it). Each entry: the time,
  then rows of two labelled values, left and right aligned, entries separated by a line.

## Known issues

- Matching is by time only (the cloud gives no link between a grind and a shot). Two grinds and
  two shots close together can be paired differently from the official app.
- Shots only appear when the grinder has a paired Sync Scale (the grinder device reads its scale's
  shots); the separate Sync Scale device isn't used by the widget.
