# Changelog

All notable changes to UHPPOTE Desk. Versions follow [Semantic Versioning](https://semver.org); every release is
also published as a Docker image `ghcr.io/alexbn71/uhppote-desk:<version>` (see [docs/DOCKER.md](docs/DOCKER.md)).

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

[1.0.0]: https://github.com/alexbn71/UHPPOTE-Desk/releases/tag/v1.0.0
