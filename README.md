# Mahlkönig Sync for Homey

Brings the grind and shot data of a **Mahlkönig E64 WS** grinder (and a paired **Sync Scale**)
into Homey Pro, so you can build flows with it.

> **Disclaimer:** this is a community app. It is not made, endorsed or supported by Mahlkönig or
> Hemro. It uses the same undocumented cloud API as the official Mahlkönig Sync app, which can
> change or stop working at any time.

## How it works

The E64 WS has no local API: it only talks to the Mahlkönig Sync cloud. This app signs in to that
cloud with your own Sync account and checks for new grinds and shots every 2 minutes (adjustable).
It only **reads** data: it can't start a grind or change the grinder's settings.

## Installation

1. Install the app on your Homey Pro.
2. Go to **Devices → + → Mahlkönig Sync → E64 WS**.
3. Sign in with the e-mail address and password of your Mahlkönig Sync account (the account you use
   in the Sync app).
4. Pick your grinder and add it.
5. Optionally add your Sync Scale the same way: **Devices → + → Mahlkönig Sync → Sync Scale**.

No Store ID or other code is needed. If you change your Sync password later, open the device and
choose **Repair** to sign in again.

## What you get

### E64 WS: device values

| Value | Notes |
|---|---|
| Dose (g) | Of the last grind |
| Grind setting | The disc distance in µm |
| Grind time (s) | Of the last grind |
| Last grind | Date and time of the last grind |
| Target dose, target grind setting, target shot time | From the recipe used for the last grind |
| Recipe mode | For example `Gbw` (grind by weight) |
| Standby | Whether the grinder is in standby |
| Motor temperature | °C, as reported by the grinder |
| Yield (g), shot time (s), brew ratio | Only appear when a Sync Scale is paired with the grinder |

Purges (see below) don't change the dose, grind setting, grind time or last grind: those always
show your last real grind.

The device settings also show the grinder's model, serial number, firmware and paired scale.

### Sync Scale: device values

| Value | Notes |
|---|---|
| Yield (g) | Of the last shot |
| Shot time (s) | Of the last shot |
| Last shot | Date and time of the last shot |

The device settings show the scale's serial number and the grinder it's paired with in Sync. The
scale has no dose or ratio: those come from the grinder, whose own *Shot completed* card has them.

### Flow cards

**When…** (E64 WS)

- **Grind completed**, with the tokens *Dose (g)*, *Grind setting*, *Grind time (s)*,
  *Portafilter detected* (yes when the grind started because you inserted the portafilter, no
  when it was started with the button) and *Is purge* (yes/no).
  Fires once for every grind, purges included: add a check on *Is purge* to leave them out.
- **Shot completed** (Sync Scale), with the tokens *Yield (g)*, *Shot time (s)*, *Dose (g)* and
  *Ratio*. Dose and ratio come from the grind the Mahlkönig Sync cloud links to the shot (like the
  official app does); they are 0 when there is none.

**When…** (Sync Scale)

- **Shot completed**, with the tokens *Yield (g)* and *Shot time (s)*.

If you add both the grinder and the scale, a shot fires both *Shot completed* cards: use the
grinder's when you want dose and ratio, the scale's when you only care about the shot.

**And…** (E64 WS)

- **Last grind was less than … minutes ago** (can be inverted to "more than"). Purges don't count.

### Espresso widget

Add the **Espresso** widget to a Homey dashboard and pick your grinder in its settings. It looks like
the history in the Mahlkönig Sync app: a timeline of your latest grinds and shots (1, 3, 5 or 10, set in
the widget settings), newest first. With 1 it shows just the latest grind or shot, without the
timeline.

- A grind with its shot (as the Mahlkönig Sync cloud links them) shows both cards joined together:
  grind weight and brew time with how far they were off the recipe's targets (green, orange or
  red, like the official app), disc distance, brew weight and the brew ratio.
- A grind without a shot (purges included) shows grind weight and disc distance.
- A shot without a grind shows brew weight and brew time.

The widget updates by itself after each check and doesn't use any extra internet traffic. Shots
need a Sync Scale paired with the grinder.

### Purges

The cloud records every grind, including a short purge to clear the chute. A grind counts as a
purge when its dose is below the **Purge below** device setting (default 5 g). A grind the grinder
didn't weigh (0.0 g) is not a purge: its dose is shown as unknown.

### Device settings

| Setting | Default | |
|---|---|---|
| Check every | 2 minutes | How often the app asks the cloud for new data. At least 1 minute. Both devices. |
| Purge below | 5 g | E64 WS only. Grinds with a smaller dose count as purges. |

## Limitations

- **Cloud-dependent and delayed.** Grinds and shots reach Homey only after the grinder has
  uploaded them and the next check has run, so expect up to a few minutes of delay. Without
  internet, or during a Mahlkönig outage, the device shows as unavailable and recovers by itself.
- **Read-only.**
- **Undocumented API.** Mahlkönig can change it at any time, which can break the app until it's
  updated.
- Grinds or shots that are more than an hour old when the app first sees them (for example after
  Homey was offline) update the device but don't fire flows.
- Only the E64 WS and the Sync Scale have been tested. Other Sync grinders may work but are
  untested.

## Privacy

Your e-mail address and password are stored on your Homey (in the device), are only sent to
Mahlkönig Sync, and are never logged.

## Credits

The cloud API was first worked out by the Home Assistant integration
[tomereli/ha-mahlkoenig-sync](https://github.com/tomereli/ha-mahlkoenig-sync) (MIT licence). This
app is an independent reimplementation; the endpoints it uses are documented in
[docs/sync-api.md](docs/sync-api.md).

## Development

```bash
npm install
npm run lint
npm test
homey app run
```

See [CLAUDE.md](CLAUDE.md) and [docs/](docs/) for the developer documentation.
