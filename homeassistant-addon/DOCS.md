# UHPPOTE Desk

Web application to manage **UHPPOTE UT0311-L0x** access controllers (1/2/4-door Wiegand boards), replacing the
Windows "Access Control" software (N3000): doors, people, cards and permissions, live monitor, event history,
attendance, notifications and a mobile app.

## Installation

1. Install the add-on and start it. The defaults work on most home networks: you do not need to change anything.
2. Open the web interface with **Open Web UI** (port 8080) and log in as `admin`:
   - with the **Admin password** option set, use that password;
   - otherwise a password is generated on the first start: it is in the **Log** tab of the add-on and must be
     changed at the first login.
3. Go to **Controllers → Search network** and add your controller.

## Home Assistant integration

If the **Mosquitto broker** add-on (or another MQTT broker known to Home Assistant) is installed, the add-on uses it
automatically: under *Settings → Devices & services → MQTT* one device per controller and one per door appear,
with door and lock states, the last person who swiped, access events for automations and *Open* buttons.

Details, entities and example automations:
[Home Assistant guide](https://github.com/alexbn71/UHPPOTE-Desk/blob/main/docs/HOME-ASSISTANT.md).

## Options

| Option | Default | Meaning |
|---|---|---|
| Admin password | empty | Password of the `admin` user, applied at every start. Empty: generated on the first start (see the log). |
| Event destination | IP of Home Assistant | `IP:port` the controllers send their events to, e.g. `192.168.1.10:60001`. Set it when Home Assistant has several networks and the controllers are not on the main one. |
| Discovery broadcast | broadcast of the main network | Address used to discover the controllers, e.g. `192.168.1.255:60000`. |
| Home Assistant integration | on | Publish controllers, doors and events through the MQTT broker. |
| Open doors from Home Assistant | on | Off: Home Assistant sees doors and events but gets no *Open* buttons. |
| Language of the entities | `en` | Language of the entity names and event texts: `en`, `it`, `es`, `fr`, `de`. |
| Public address | empty | Public HTTPS address behind a reverse proxy, for the mobile app (fingerprint/Face ID, push). |
| HTTPS-only cookies | off | On when the interface is published over HTTPS through a reverse proxy. |
| Packet debug | off | Log every packet exchanged with the controllers. |
| Log level | `info` | `debug`, `info`, `warn`, `error`. |

The add-on uses the **host network**: the controllers are discovered with UDP broadcast and send their events over
UDP (port 60001). The web interface is on port **8080** of Home Assistant; make sure no other add-on uses it.

## Data and backups

The database, the photos and the settings are in the add-on data, so they are included in the **backups of Home
Assistant**. The daily backups made by the application itself (`/data/backups`) are excluded from them.

## Support

- Questions: [Discussions](https://github.com/alexbn71/UHPPOTE-Desk/discussions)
- Bugs: [issues](https://github.com/alexbn71/UHPPOTE-Desk/issues/new/choose) — please include the add-on log
- User manual (PDF): [latest release](https://github.com/alexbn71/UHPPOTE-Desk/releases/latest)
