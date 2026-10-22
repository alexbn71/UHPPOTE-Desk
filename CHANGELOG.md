# Changelog

All notable changes to UHPPOTE Desk. Versions follow [Semantic Versioning](https://semver.org); every release is
also published as a Docker image `ghcr.io/alexbn71/uhppote-desk:<version>` (see [docs/DOCKER.md](docs/DOCKER.md)).

## [Unreleased]

### Added
- **Emergency access for administrators** (`ADMIN_2FA_BYPASS=true`, add-on option *Emergency access without
  two-factor authentication*): administrators log in with the password only and can switch off their own
  two-factor authentication without a code, also when it is mandatory — for the only administrator who lost phone
  and recovery codes. Operators and read-only users still need their code. Red banner in the app, warning at start,
  logins marked in the audit log.

### Fixed
- Italian: "Sincronizza ora" (clock) read as "synchronise now": it is now *Sincronizza orologio*.

## [1.2.0] - 2026-10-21

### Added
- **Expansion board outputs live**: for controllers with *Expansion board connected* UHPPOTE Desk reads the status
  of the manufacturer's console (long packet `0x20/0x20`, found in a capture of its *Monitor*), the only one that
  reports the four board outputs and its fire input. They are shown on the dashboard, in the controller
  *Diagnostics* and as Home Assistant binary sensors *Expansion output 1–4*; after an event, or while something is
  on, they are followed every 2 s until off. Hardware test L6.10 checks every output against it.
- **Two-factor authentication** for the operators (authenticator app, TOTP): activated by each operator from the new
  shield icon in the header with a QR code, then asked at login after the password; 10 single-use recovery codes;
  administrators see who has it, can reset it for a lost phone and choose on the *Operators* page who must use it
  (nobody, administrators, operators and administrators, everybody: set up at the next login) — see
  [docs/DOCKER.md](docs/DOCKER.md#two-factor-authentication).
- **Licence plates**: plate-reading cameras (tested with AgentDVR) open doors for known vehicles, replacing the
  Node-RED glue. Plates belong to people (*Plates* tab: their permissions and time profiles apply, evaluated by the
  server) or to guest passes (new *Vehicle plates* field). Cameras (*Operations → Licence plates → Cameras*,
  administrators) have a door, a secret key used in the two AgentDVR addresses (list of known plates and "Call URL"),
  a photo address (AgentDVR `grab.jpg`), a pause after an opening and a "record only" mode. Every reading is stored
  with its photo (kept `PLATE_PHOTO_DAYS`, default 30) and published as `plate.granted` / `plate.denied`; Telegram
  and email notifications include the photo; rules match the owner and have `{plate}`; persons inside counts vehicles
  — see [docs/PLATES.md](docs/PLATES.md).
- **Guests**: links that open some doors without a card or an app (*Registry → Guests*, operators and
  administrators). A pass has a validity period, optionally only some days and hours (e.g. every Tuesday
  09:00–12:00), a maximum number of openings, is bound to the first phone that opens a door with it and can require
  a PIN (blocked after 5 wrong ones). The guest page `/g/<code>` needs no login and has *hold to open* buttons; the
  link is shown once, with *Share* / WhatsApp / copy, and only its hash is stored. New events `guest.opened` and
  `guest.refused` for notifications, push, webhooks and rules; failed attempts are rate-limited per address — see
  [docs/GUESTS.md](docs/GUESTS.md).
- **Alarm expansion board (UT0311-01A), experimental**: new *Expansion board* tab on the controller page to
  configure the four alarm outputs (source door or burglar alarm, output mode, triggering events, signals, duration),
  the "door open too long" time and the duress code. The configuration is written with function `0xF2`
  (reconstructed from the manufacturer's software), only on controllers marked as having the board, and again by
  the full synchronisation — see [docs/EXPANSION-BOARD.md](docs/EXPANSION-BOARD.md).
- Expansion board **alarm options** (the matching vendor "extended functions"): door open too long raises an alarm,
  invalid card alarm only after 3 attempts, duress code only after a registered card.
- **Read from the controller** on the *Expansion board* tab: the parameter table is read back with the vendor
  long-packet request (0x24/0x10, CRC-16/ARC), shown next to the saved configuration and copied into the form if
  wanted; every save is verified by reading the table back.
- Hardware test level **L6** (`npm run hw -- --level 6`): parameter table read, address mapping check,
  configuration write verified by read-back and guided tests of the board relays (forced open, open too long,
  invalid card, fire input, duress code).
- FakeController: parameter table, simulated expansion relays, `raiseAlarm` and `setFireInput`.
- Wireshark dissector (`tools/wireshark/uhppote.lua`) and `npm run pcap`, which reconstructs the expansion board
  written in a capture and compares it with a configuration.
- **Persons inside** page: who is inside now, from the last granted swipe of each person on the doors set as
  *entry* or *exit* (new *Persons inside* field of the doors; exit readers of two-reader doors count as exits),
  for today or the last 8/24 hours, with CSV export.
- **Reader and door options** in *Advanced settings* (the vendor "extended functions"): four swipes = normally
  open, silent reader on invalid cards, minimum gap between two swipes of the same card, door as switch and
  multi-card access (cards needed per door). Multi-card access, door as switch and the swipe gap write the same
  bytes as the vendor software (checked on captures). Written with `0xF2` only when *Managed by UHPPOTE Desk* is on,
  verified by reading the table back, with *Read from the controller*; hardware test level **L7** restores the
  original bytes exactly.
- **Update notice**: a page opened before the server was updated shows *New version available* with a *Reload*
  button. `/api/health` now also reports `build`, the entry bundle of the web build being served.

### Fixed
- *Reader and door options*, after the hardware tests on a UT0311-L04 (firmware v9.f8): the "minimum gap between
  two swipes" does not refuse the card — the door opens, the repeated swipes of the same card within the interval
  are just not recorded; it is now called *Don't record repeated swipes of the same card*. *Four swipes = normally
  open* is stored by this firmware but has no effect; *Silent reader on invalid cards* can only affect the reader LED (the
  controller has no buzzer output: the beep comes from the reader) and needs the LED wire connected: the hints say
  so.
  Hardware tests L7.2–L7.4 now log the events and compare the reader with the option off and on.
- **Fire alarm** (Home Assistant *Fire alarm* sensor, live monitor): it turned on only at the next status check
  (up to `HEALTH_INTERVAL_SEC` later, or never for a short alarm) because the packet of the fire event still has the
  fire bit clear, and turned off late because releasing the fire input sends no event. It now turns on at the event
  and, while it lasts, the controller is polled every 2 s. Found with the UT0311-01A board fire input.
- The live connection (WebSocket of the monitor) was accepted also before the forced password change; it now
  waits, like every other request, for the password change and the mandatory two-factor setup.
- The header buttons *Change password* and *Log out* have an accessible name (screen readers, tests).
- *Network and configuration*: the "send new IP" form and the listener form start from the configuration read
  from the controller (address, netmask, gateway, listener) instead of a fixed netmask and an empty gateway.

## [1.1.0] - 2026-10-15

### Added
- **Home Assistant add-on**: install UHPPOTE Desk from the add-on store of Home Assistant OS (add this repository in
  *Settings → Add-ons → Add-on store → Repositories*). The MQTT broker of Home Assistant, the network addresses and
  the time zone are configured automatically; the database is included in the Home Assistant backups.
- **ARM64 image** (`linux/arm64`) besides `linux/amd64`: Raspberry Pi 4/5, ARM NAS and mini PCs.

## [1.0.0] - 2026-10-15

First public release: a web application that replaces the Windows "Access Control" software (N3000) for
**UHPPOTE UT0311-L0x** access controllers.

### Controllers and doors
- Discovery of the controllers on the network, configuration of address, listener and clock (UDP or TCP)
- Door modes and delays, interlock, anti-passback, keypads and door passcodes, first card
- Remote door opening, scheduled tasks, time profiles
- Diagnostics: device data, firmware, stored cards, door sensors and relays
- Automatic synchronisation of cards and permissions, full comparison and alignment; controllers that lost their
  memory are restored automatically

### People, cards and access
- People with photo, department, validity dates, keypad PIN and shift; CSV import
- Wiegand-26 cards, capture of unknown cards from a reader, lost-card replacement
- Permissions per door with time profiles, bulk grant and revoke
- Departments and zones; operators with roles (viewer, operator, administrator) limited to zones; audit log

### Monitoring and reports
- Dashboard with controller and door states, today's swipes and activity charts
- Live monitor with the photo of the person, event history with filters and CSV export
- Attendance: shifts, holidays, leave, manual punches and reports
- Anomaly detection: accesses at unusual times, repeated denied attempts, cards unused for months

### Integrations
- Home Assistant over MQTT with automatic discovery
- Signed outgoing webhooks with retries and a delivery log
- Notifications on Telegram (with an *Open door* button), email, ntfy and Gotify, and a daily report
- Automation rules: notifications, webhooks or door opening when an event matches the conditions
- API tokens for machine-to-machine access

### Mobile app
- PWA at `/m`, installable on the home screen: doors with live state, *hold to open* or fingerprint/Face ID,
  push notifications with an *Open* action, remembered devices revocable by the administrator

### Interface
- English, Italian, Spanish, French and German, including the errors reported by the controllers
- Light and dark theme

### Installation
- Docker image for `linux/amd64` with Unraid template; guide for Docker Compose, Unraid, Synology and QNAP
- `ADMIN_PASSWORD` to set the administrator password, automatic database creation and backups
- User manual in PDF with screenshots of every page

### License
- GNU Affero General Public License v3.0 or later, with the additional term of
  [ADDITIONAL-TERMS.md](ADDITIONAL-TERMS.md): the author credits shown in the application must stay visible

[1.2.0]: https://github.com/alexbn71/UHPPOTE-Desk/releases/tag/v1.2.0
[1.1.0]: https://github.com/alexbn71/UHPPOTE-Desk/releases/tag/v1.1.0
[1.0.0]: https://github.com/alexbn71/UHPPOTE-Desk/releases/tag/v1.0.0
