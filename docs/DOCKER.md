# Installation with Docker

This guide explains how to install UHPPOTE Desk with Docker on a server or NAS and how to configure it for your network. Nothing needs to be compiled: you use the ready-made image.

## Image

| | |
|---|---|
| Image | `ghcr.io/alexbn71/uhppote-desk` |
| Tags | `latest` (latest version of `main`), `<x.y.z>` (a release, e.g. `1.0.0`), `<x.y>` and `<x>` (latest release of that series, e.g. `1`), `sha-<commit>` (exact commit) |
| Architecture | `linux/amd64` |
| Ports | `8080/tcp` web interface (configurable) · `60001/udp` events from the controllers |
| Volume | `/data`: database, backups, photos, test reports — a named volume or a host folder |
| Icon | `https://raw.githubusercontent.com/alexbn71/UHPPOTE-Desk/main/apps/web/public/icon-512.png` (label `net.unraid.docker.icon`) |

To stay on a release instead of following `main`, use a version tag: `ghcr.io/alexbn71/uhppote-desk:1` receives the 1.x releases (new features and fixes, no breaking changes), `:1.0.0` never changes. The releases and their notes are on the [releases page](https://github.com/alexbn71/UHPPOTE-Desk/releases) and in [CHANGELOG.md](../CHANGELOG.md).
| User | the application runs as `PUID:PGID` (default `1000:1000`); see [Data folder and permissions](#data-folder-and-permissions) |

The image is built and verified by GitHub Actions on every change: tests, a trial start of the container, publication.

## Network requirements (important)

The server and the controllers communicate over **UDP**. This requires a few conditions:

1. **The container must use `host` networking** (`network_mode: host` / `--network host`).
   With Docker's bridge network the controller discovery (broadcast) never leaves the container and the events the controllers send to the server never arrive. Mapping ports is not enough.
2. **The server and the controllers must be on the same local network**, i.e. the same subnet, for automatic discovery to work. If the controllers are on another subnet it still works, but their IP addresses must be entered manually in the app.
3. **Firewall**: inbound UDP port `60001` (or the one set in `UHPPOTE_LISTEN`) and the TCP port of the web interface must be open.
4. **Security**: the controller protocol is neither authenticated nor encrypted. Put controllers and server on a separate network (VLAN) and make the web interface reachable only from the local network or through a VPN.

## Environment variables

In the examples the server has IP `192.168.1.10` and the controllers are on the `192.168.1.0/24` subnet. Replace them with your own values.

### Required

| Variable | Description | Example |
|---|---|---|
| `UHPPOTE_LISTENER_PUBLIC` | `IP:port` **of this server** as seen by the controllers. It is written into the controllers as the destination for their events. Without it events still arrive, but with a delay, through periodic polling. | `192.168.1.10:60001` |

### Recommended

| Variable | Default | Description | Example |
|---|---|---|---|
| `UHPPOTE_BROADCAST` | `255.255.255.255:60000` | Broadcast address used to discover controllers. Use the broadcast address of the controllers' subnet: on servers with several network interfaces (NAS, Unraid, hosts running Docker or VMs) the generic address may leave through the wrong interface. | `192.168.1.255:60000` |
| `ADMIN_PASSWORD` | generated | Password of the `admin` user. **Set**: it is applied at every start (the user is recreated/re-enabled if needed, and changing the variable changes the password); it cannot be changed from the application. **Not set**: a password is generated on the first start, written to the container log, and must be changed at first login. | — |
| `TZ` | system time | Time zone. Determines the time set on the controllers and the times shown in reports. | `Europe/Rome` |
| `HTTP_PORT` | `8080` | Port of the web interface. With `host` networking it must not already be used by another service. | `8080` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `UHPPOTE_BIND_ADDR` | `0.0.0.0` | Local IP used to talk to the controllers. Set it when the server has several network interfaces and you want to use only one (e.g. `192.168.1.10`). |
| `UHPPOTE_LISTEN` | `0.0.0.0:60001` | Address and UDP port on which events are received. If you change the port, change it in `UHPPOTE_LISTENER_PUBLIC` too. |
| `UHPPOTE_TIMEOUT_MS` | `2500` | Maximum wait for a controller reply. |
| `UHPPOTE_RETRIES` | `1` | Additional attempts after a timeout. Applied only to operations that can be repeated safely; opening a door is never retried. |
| `UHPPOTE_DEBUG` | `false` | `true` writes every packet exchanged with the controllers to the log, in hexadecimal (for diagnostics). |
| `SECURE_COOKIES` | `false` | `true` if the interface is published over HTTPS through a reverse proxy. |
| `PUBLIC_URL` | — | Public HTTPS address behind the reverse proxy (e.g. `https://doors.example.com`), used by the [mobile app](MOBILE.md) for fingerprint/Face ID and push notifications. |
| `SESSION_HOURS` | `12` | Operator session duration. |
| `HEALTH_INTERVAL_SEC` | `15` | Interval for checking controller status (online/offline, doors). |
| `COLLECT_INTERVAL_SEC` | `300` | Interval at which events are also downloaded from the controller, as a safety net in case a pushed event is lost. |
| `TIME_SYNC_THRESHOLD_SEC` | `30` | Difference in seconds beyond which the controller clock is corrected automatically (`0` = never). |
| `INITIAL_BACKFILL` | `5000` | Number of events already stored on a controller to import the first time it is connected. |
| `BACKUP_HOUR` | `2` | Hour of the daily database backup (`-1` = disabled). |
| `BACKUP_KEEP` | `14` | Number of backups to keep. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

### Home Assistant (MQTT)

All optional: without `MQTT_URL` the integration is off. Details in **[HOME-ASSISTANT.md](HOME-ASSISTANT.md)**.

| Variable | Default | Description |
|---|---|---|
| `MQTT_URL` | — | Broker URL, e.g. `mqtt://192.168.1.10:1883` or `mqtts://broker.lan:8883`. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | — | Broker credentials. |
| `MQTT_DOOR_CONTROL` | `true` | `false` = Home Assistant sees doors and events but gets no *Open* buttons, and open commands are ignored. |
| `MQTT_LANGUAGE` | `en` | Language of the entity names and event texts: `en`, `it`, `es`, `fr`, `de`. |
| `MQTT_BASE_TOPIC` | `uhppote-desk` | Prefix of the published topics. |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | Home Assistant discovery prefix (change it only if you changed it in Home Assistant). |

### Data folder owner

| Variable | Default | Description |
|---|---|---|
| `PUID` | `1000` | User ID the application runs as, and owner of the data folder |
| `PGID` | `1000` | Group ID the application runs as, and group of the data folder |

### Already set in the image (do not change)

| Variable | Value |
|---|---|
| `DATA_DIR` | `/data` |
| `WEB_DIR` | `/app/web` |
| `HWTEST_REPORT_DIR` | `/data/reports` |
| `NODE_ENV` | `production` |

## Installation with Docker Compose

Uses [docker/docker-compose.yml](../docker/docker-compose.yml) and [docker/.env.example](../docker/.env.example):

```bash
git clone https://github.com/alexbn71/UHPPOTE-Desk.git
cd UHPPOTE-Desk/docker
cp .env.example .env
# edit .env: at least UHPPOTE_LISTENER_PUBLIC and UHPPOTE_BROADCAST
docker compose up -d
docker logs uhppote-desk          # admin password, if ADMIN_PASSWORD is not set
```

Minimal `docker-compose.yml`, if you don't clone the repository:

```yaml
services:
  uhppote-desk:
    image: ghcr.io/alexbn71/uhppote-desk:latest
    container_name: uhppote-desk
    restart: unless-stopped
    network_mode: host
    environment:
      UHPPOTE_LISTENER_PUBLIC: 192.168.1.10:60001
      UHPPOTE_BROADCAST: 192.168.1.255:60000
      TZ: Europe/Rome
    volumes:
      - ./data:/data
```

> A host folder (`./data` above) can be used directly: it is created if missing and the database is initialised on first start. See [Data folder and permissions](#data-folder-and-permissions).

## Data folder and permissions

`/data` holds the SQLite database (`uhppote-desk.sqlite`), daily backups, photos and test reports. It can be a Docker named volume or any folder of the host (bind mount).

- **First start**: if the folder or the database does not exist, they are created and the database schema is initialised (log: `no database found in /data: creating a new one`). On later starts the existing database is reused and upgraded if needed (log: `using database /data/uhppote-desk.sqlite`).
- **Ownership**: the container starts as root only to prepare the folder: it creates it if missing and, when needed, changes its owner to `PUID:PGID`. It then runs the application as that user, never as root. Set `PUID`/`PGID` to the owner you want on the host (e.g. your user, `id -u` / `id -g`; on Unraid `99`/`100`).
- **Starting with `--user`** (or `user:` in compose) skips that preparation: the folder must then already be writable by that user. If it is not, the container stops with a message like `the data directory /data is not writable by the process (uid 1000, gid 1000)` and the fix to apply.
- Running the hardware test tool with `docker exec` uses root by default; the next start restores the correct owner automatically, or use `docker exec --user <PUID>:<PGID> …`.

## Installation with `docker run`

```bash
docker run -d --name uhppote-desk --restart unless-stopped \
  --network host \
  -e UHPPOTE_LISTENER_PUBLIC=192.168.1.10:60001 \
  -e UHPPOTE_BROADCAST=192.168.1.255:60000 \
  -e TZ=Europe/Rome \
  -v uhppote-desk-data:/data \
  ghcr.io/alexbn71/uhppote-desk:latest
```

With a host folder instead of a named volume: `-v /srv/uhppote-desk:/data -e PUID=$(id -u) -e PGID=$(id -g)`.

## Installation on Unraid

1. From the Unraid terminal, download the template:
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-uhppote-desk.xml \
     https://raw.githubusercontent.com/alexbn71/UHPPOTE-Desk/main/docker/unraid/uhppote-desk.xml
   ```
2. **Docker → Add Container → Template: uhppote-desk**.
3. Fill in at least **Event destination** (`UHPPOTE_LISTENER_PUBLIC`) and **Discovery broadcast** (`UHPPOTE_BROADCAST`), and check that the **Web port** is free. The other variables are under *Show more settings*.
4. The template already sets:
   - **`host` networking**;
   - **data folder** `/mnt/user/appdata/uhppote-desk` mounted on `/data`;
   - **`PUID=99`, `PGID=100`** (`nobody:users`), the standard owner of `appdata`.
5. **Apply**, then open the WebUI from the container icon.

## Other NAS systems

- **Synology (Container Manager)**: create a *Project* with the example `docker-compose.yml`. `network_mode: host` is supported.
- **QNAP (Container Station)**: create an application from the example compose file, or choose *Host* networking when creating the container manually.

On both, make sure the data folder is writable by the container user (see the note in the Docker Compose section).

## First start

1. Open `http://<server-IP>:<HTTP_PORT>` and log in as `admin`: with `ADMIN_PASSWORD` set use that password; otherwise use the one printed in the container log (`Created user 'admin' with temporary password: …`), and you are asked for a new password immediately.
2. **Controllers → Search network**: the controllers reachable by broadcast are listed with serial number, IP and firmware. **Add** registers them in the app. The interface language can be changed from the language menu in the header.
3. As soon as a controller is online, the app sends it the event destination (`UHPPOTE_LISTENER_PUBLIC`) and synchronises its clock. If a controller comes online **without any card** while the database expects some (factory reset, replaced controller), the app synchronises it completely by itself; any other difference is only reported in the log, and **Synchronisation** aligns it. You can check this in **Controllers → (controller) → Diagnostics**, "Event listener" entry.

## Commissioning from the container

The hardware test suite is included in the image:

```bash
docker exec -it uhppote-desk node hwtest/cli.js --help
docker exec -it uhppote-desk node hwtest/cli.js --serial <S/N> --ip <controller IP> --level 0,1
docker exec -it uhppote-desk node hwtest/cli.js --serial <S/N> --ip <controller IP> --level 5   # full deployment check
```

Reports are saved in `/data/reports`. The test levels are described in the [README](../README.md#commissioning-with-a-real-controller).

## Trying the app without a controller (simulator)

The image also contains a simulated 4-door UT0311-L04 controller. Run it inside the running container (it shares the host network, so the app sees it like a real controller on the LAN):

```bash
docker exec -it uhppote-desk node hwtest/devsim.js              # interactive: keyboard commands
docker exec -d  uhppote-desk node hwtest/devsim.js --auto 10    # background: a random swipe every 10 s
```

- Then use **Controllers → Search network** and add controller `405419896`. If the search finds nothing, add it manually with the server's LAN IP.
- The simulated controller reports the server's IP on the `UHPPOTE_BROADCAST` subnet (or the first LAN address). Use `--address <IP>` to force it, and `--serial <n>` to change the serial number.
- Interactive commands: `s <card> [door]` swipe, `o <door>` / `c <door>` door sensor open/closed, `b <door>` exit button, `l` cards, `e` last events, `off` / `on` simulate a cable unplugged, `q` quit.
- It listens on UDP/TCP port 60000 of the host: stop it before connecting a real controller on the same host, and do not run it twice.
- Like a real controller it keeps its memory (cards, time profiles, settings, events) when it stops or the container restarts: it is saved in `/data/devsim-<serial>.json`. Run it with `--fresh` to start with an empty memory (as after a factory reset).
- Restarting the container also stops the simulator: start it again with the same command.
- To stop a background simulator: `docker restart uhppote-desk`.

## Updates and backups

- **Update**: `docker compose pull && docker compose up -d`. On Unraid: *Check for updates* → *Update*. The database schema is upgraded automatically at startup.
- **Automatic backup**: every day at `BACKUP_HOUR` into `/data/backups`, or manually from *System → Create backup now*. For a complete backup, copy the data folder.
- Before a controller factory reset, its cards are saved to `/data/backups/cards-<serial>-<date>.json`.

## Troubleshooting

| Symptom | Likely cause | Solution |
|---|---|---|
| Network search finds no controllers | The container is not using `host` networking, the controller is on another subnet, or the broadcast leaves through the wrong interface | Use `host` networking; set `UHPPOTE_BROADCAST` to the subnet broadcast and/or `UHPPOTE_BIND_ADDR`; alternatively add the controller manually with its IP |
| Controller online but events delayed (only every `COLLECT_INTERVAL_SEC`) | `UHPPOTE_LISTENER_PUBLIC` missing or wrong, or UDP port 60001 blocked | Check in *Diagnostics* that "Event listener" shows the server IP; open UDP port 60001 in the firewall |
| Log warning "UHPPOTE_LISTENER_PUBLIC not set" | Variable missing | Set it and restart the container |
| Log error "cannot start the event listener"; the server runs but events arrive only every `COLLECT_INTERVAL_SEC` | Another service is already using UDP port 60001 | Change `UHPPOTE_LISTEN` and `UHPPOTE_LISTENER_PUBLIC` |
| `startup failed: the data directory /data is not writable by the process …` (or `cannot open the database`) | The container was started with `--user`/`user:` and the host folder belongs to someone else | Remove `--user` and set `PUID`/`PGID` instead (the container then fixes the folder owner), or `chown -R <uid>:<gid>` the host folder |
| The web interface does not open | Port in use or blocked by the firewall | Change `HTTP_PORT` |
| Wrong time on the controllers or in reports | `TZ` not set | Set `TZ`, e.g. `Europe/Rome` |
| *System* shows MQTT "not connected"; log `MQTT: broker … unreachable` | Wrong `MQTT_URL`, credentials or firewall | Check the URL and the user in the broker; see [HOME-ASSISTANT.md](HOME-ASSISTANT.md#troubleshooting) |
| Forgotten `admin` password | — | Set `ADMIN_PASSWORD` and restart the container: the new password is applied |
| Log warning "INITIAL_ADMIN_PASSWORD is deprecated" | Old variable name | Rename it to `ADMIN_PASSWORD` (the old name still works as a fallback) |
