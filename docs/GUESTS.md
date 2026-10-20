# Guests

A guest pass is a **link** that opens some doors for a while. The guest receives it via WhatsApp, SMS or email, opens it on the phone and holds a button to open the door: **no card, no app, no login**. Typical uses: a courier or a technician today, a friend for the weekend, the cleaner every Tuesday morning.

Passes are managed in *Registry → Guests* by operators and administrators. Operators create passes only for the doors they may open themselves (role and zones) and see only those passes; administrators see all of them.

## Creating a pass

*New guest*:

| Field | Meaning |
|---|---|
| **Name** | Shown to the guest ("Hi Mario") and in notifications, history and audit log |
| **Note** | For operators only (company, reason of the visit) |
| **Doors** | The doors the link opens |
| **From / Until** | Validity period, date and time. The buttons *Today*, *Tomorrow*, *7 days*, *30 days* fill it in |
| **Only on some days and hours** | Within the period, only on these days and between these times, e.g. Tuesday 09:00–12:00. A window can cross midnight (22:00–06:00) |
| **Maximum openings** | After that many openings the link stops working; empty = unlimited |
| **Only on the first phone that uses it** | On by default: see [Bound to one phone](#bound-to-one-phone) |
| **Require a PIN** | 4–8 digits the guest must type; *Generate* proposes a random one |

After saving, UHPPOTE Desk shows the message to send, with the buttons **Share** (the phone's share menu, when the browser has one), **WhatsApp**, **Copy message** and **Copy link**. Give the PIN separately, by voice or on another channel, not in the same message as the link.

**The link is shown only at that moment**: UHPPOTE Desk keeps only its SHA-256 hash, like [API tokens](API-TOKENS.md). If it gets lost, use *New link*: the old link stops working at once.

The address of the link is `PUBLIC_URL` when it is set, otherwise the address the operator is using in the browser.

## What the guest sees

The page `https://<your address>/g/<code>` shows the name, the validity and one *Hold to open* button per door (a short touch does not open). When the pass is not usable it explains why: not valid yet, outside the hours, expired, used up, revoked, blocked after wrong PINs, or in use on another phone. The page follows the language of the phone (English, Italian, Spanish, French, German) and has a language menu.

## Bound to one phone

With *Only on the first phone that uses it*, the first browser that **opens a door** with the link becomes the only one allowed: a forwarded link does not work elsewhere, and every refused attempt is recorded and notified (`guest.refused`). Just opening the page, or the preview that WhatsApp and Telegram build for links, does not bind the pass.

The binding uses a random cookie of the browser (`uhd_guest`, stored on the server as a hash). It is lost when the guest clears the browser data, uses a private window or opens the link in a different browser, for example the browser built into an app instead of Chrome or Safari. In those cases use **Allow another phone** (icon in the list): the next phone that opens a door becomes the bound one.

## PIN

- With the pass bound to a phone, the PIN is asked only until the first opening on that phone.
- Without binding, the PIN is asked at every opening.
- After **5 wrong PINs** in a row the pass is **blocked** (status *Blocked (PIN)*): *Unlock* in the list, or a new PIN, unblocks it.

## Status

| Status | Meaning |
|---|---|
| Active | Usable now |
| Not yet valid | Before *From* |
| Outside hours | Inside the period, but not on these days or at these times |
| Expired | After *Until* |
| Used up | Maximum openings reached |
| Blocked (PIN) | Too many wrong PINs |
| Revoked | Revoked by an operator: the link no longer works |

Expired, used up and revoked passes are hidden from the list unless *Show expired and revoked* is on. *Delete* removes a pass and its history.

The **History** of a pass lists every attempt, successful or not, with door, outcome and IP address. Openings also appear in the audit log as `guest-open-door` by `guest:<name>`, and in the event history as the controller's remote opening.

## Notifications, webhooks and rules

Two event types can be chosen in [notifications](NOTIFICATIONS.md), push notifications of the [mobile app](MOBILE.md), [webhooks](WEBHOOKS.md) and [automation rules](RULES.md):

| Type | When |
|---|---|
| `guest.opened` | A door was opened with a guest link |
| `guest.refused` | A guest link was refused at a door: another phone, wrong PIN, blocked, not valid yet, outside hours, expired, used up, revoked |

The webhook `data` is:

```json
{
  "passId": 7,
  "guestName": "Mario",
  "outcome": "ok",
  "createdBy": "admin",
  "timestamp": "2026-10-20 10:15:02"
}
```

`outcome` is `ok` for `guest.opened`, otherwise one of `otherDevice`, `wrongPin`, `locked`, `notYet`, `outsideHours`, `expired`, `used`, `revoked`. In a rule message `{person}` is the guest's name.

## Making the links reachable from outside

The guest's phone must reach UHPPOTE Desk. Publish it through a reverse proxy with HTTPS (e.g. Nginx Proxy Manager with Let's Encrypt) and set `PUBLIC_URL` (see [MOBILE.md](MOBILE.md#requirements) and [DOCKER.md](DOCKER.md)).

If you prefer to expose to the internet only what guests need, the proxy can forward just these paths and refuse the rest:

| Path | Why |
|---|---|
| `/g/` | The guest page |
| `/api/guest/` | Its API (pass, door opening) |
| `/assets/` | Scripts and styles of the page |
| `/api/health` | Check for a newer version |
| `/icon.svg`, `/sw.js`, `/manifest.webmanifest` | Icon and browser files |

The guest API needs no login: the link is the credential. A wrong link counts as a failed attempt of the IP address; after **10 failed attempts in 15 minutes** (wrong links or wrong PINs) the address is refused for the rest of the window. The guest pages are sent with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, and the API replies are never cached.

### Testing from a phone before going online

With an Android phone connected by USB and the development servers running (`npm run sim`, `npm run dev`):

```bash
adb reverse tcp:5173 tcp:5173
adb reverse tcp:8080 tcp:8080
```

Create the pass from `http://localhost:5173` on the PC: the link starts with `http://localhost:5173/g/…` and opens on the phone as well. For the browser `localhost` is a secure address even without HTTPS.
