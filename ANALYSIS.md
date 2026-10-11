# UHPPOTE Desk — Technical analysis

> Analysis report for a web application (Node.js + React) that replaces the Windows "Access Control" software (N3000) for the **UHPPOTE UT0311-L04** access controller (4 doors).
> Date: 2026-10-11 · Status: analysis complete, implementation done (§12), physical controller not yet tested.

---

## 1. Summary

| Topic | Conclusion |
|---|---|
| Communication | Proprietary binary protocol over **UDP port 60000**, fixed **64-byte** packets, request/response. The controller can also **push events** (UDP) to **one** configured host. Recent firmware also accepts the same frames over **TCP 60000**. |
| Protocol documentation | The manufacturer does not publish the specification. The authoritative public source is the open-source **uhppoted** project (Codeberg), which reverse-engineered all 34 commands and publishes a **JSON model with field offsets** and official binary **test vectors**. |
| Supplied manual | Only describes the N3000 software UI → used to define the **functional scope**, not the protocol. |
| Existing Node library | npm `uhppoted` 0.9.1 (MIT) covers the whole protocol but has some defects verified in its source (§7.2). **Decision**: our own **TypeScript** codec + transport (≈ 800 lines, fully testable), validated byte-for-byte against the official vectors and with differential tests against the `uhppoted` library. |
| Testing without hardware | **uhppoted-simulator** (emulates a UT0311-L04, REST API to simulate cards/doors) plus our own in-process **FakeController** allow full integration testing before the controller is available. |
| Deployment | Docker container on a NAS/server with **`network_mode: host`** (required for broadcast discovery and for receiving UDP events). |
| Stack | TypeScript monorepo: Fastify + SQLite (`node:sqlite`) + WebSocket on the server, React + Vite + Mantine on the client. |

---

## 2. Sources analysed

| Source | Content | Use |
|---|---|---|
| Manufacturer manual (PDF, not included in the repository) | UHPPOTE "Access Control Software Operation Guide", 72 pages | Functional scope, terminology, hardware notes (FAQ) |
| Manufacturer software `MJ_all_en.rar` (not included) | `N3000.exe` (.NET), `n3k_comm.dll` (communication), `n3k_jm.dll`, `SqlSet.exe`, `n3k.msi`, FTDI USB driver (WG1028 USB reader), `Readme.doc` | Confirms the legacy architecture (WinForms + Access/SQL Server). Decompiling `n3k_comm.dll` is not needed: the protocol is already documented by uhppoted |
| [node-red-contrib-uhppoted](https://flows.nodered.org/node/node-red-contrib-uhppoted) | Node-RED node (v1.1.14, 09/2026), 37 nodes | Proves the protocol works from Node.js; contains a copy of the JS codec |
| [codeberg.org/uhppoted/uhppoted-lib-node-red](https://codeberg.org/uhppoted/uhppoted-lib-node-red) | Source of the Node-RED node | Reference |
| [codeberg.org/uhppoted](https://codeberg.org/uhppoted) | Organisation: `uhppoted-core` (Go, reference implementation), `uhppoted-lib-nodejs` (npm `uhppoted`), `uhppoted-codegen` (model + vectors), `uhppoted-simulator`, `uhppoted-cli`, `uhppoted-rest`, `uhppoted-mqtt`, `uhppoted-httpd`, `uhppoted-tunnel` | Protocol specification, test tools |
| `uhppoted-codegen/bindings/.models/models.json` | Model of every request/response with **name, offset, type** | Primary source of the tables in §5 |
| `uhppoted-codegen/bindings/.models/test-data.json` | **35 test vectors** (base64 packets + expected values), one per command | Golden tests for our codec |
| npm `uhppoted@0.9.1` (source read in full) | `encoder.js`, `decoder.js`, `driver.js`, `lookup.js`, `common.js` | Cross-check of layouts, defect discovery |

> Note: the uhppoted GitHub mirrors (`github.com/uhppoted/...`) now return 404; the project lives entirely on Codeberg and several repositories were renamed (`uhppote-*` → `uhppoted-*`).

---

## 3. Hardware: UHPPOTE UT0311-L04

| Characteristic | Value |
|---|---|
| Doors / relays | 4 doors, 4 lock relays |
| Readers | 4 Wiegand inputs (one per door; the L01/L02 models use in/out readers) |
| Inputs | door sensor ×4, exit button ×4, auxiliary inputs (forced lock/fire) |
| Card format | **Wiegand-26 only** (facility 0–255 + number 0–65535). The "8-digit" number = `facility × 100000 + number` (e.g. `10058400` → facility 100, number 58400). The number printed on some cards (10 digits) **does not match**: read it by swiping the card (manual FAQ, p. 71). |
| Capacity | 20,000 cards, 100,000 events stated (uhppoted observed ~200,000) |
| Network | 10/100 Ethernet, static IP configurable through the protocol; identified by the **9-digit serial number** printed on its label |
| Firmware | Not user-upgradeable. uhppoted: minimum supported v6.56, common v6.62, developed against v8.92. **v9.158**: possible bug when deleting cards |
| Legacy credentials (from the public manual) | N3000 software: user `abc` / password `123`, extended functions `5678`, registration `2004`, Access DB `iCCard3000.mdb` password `168168` |
| Warning | The "WEB configure software" and the management software **must not be used together** (FAQ 6). The same applies to this app: only one management system at a time, especially because each controller has a single event listener |

---

## 4. Legacy software: functional scope and mapping

| N3000 function (manual section) | v1 scope | Implementation in the new app | Protocol commands |
|---|---|---|---|
| 2.2.1 Add controller (S/N) | ✅ | Controller registry, discovery | `0x94` |
| 2.2.2 Search + configure IP | ✅ | Controller page: broadcast search, set IP/netmask/gateway | `0x94`, `0x96` |
| 2.2.3 Zones | ✅ | Hierarchical zones (also used to restrict operators) | — (DB only) |
| 2.3.1 Departments | ✅ | Department tree | — |
| 2.3.2 Users (personnel) | ✅ | People + cards, photo | — |
| 2.3.3 Automatic card enrolment (USB reader / swipe on controller / batch) | ✅ (swipe + batch) | "Swipe the card": captured from the denied-swipe event; range insertion | `0x20` events |
| 2.3.5 Lost card | ✅ | Card replacement with immediate upload | `0x52`, `0x50` |
| 2.4.1 Access privileges | ✅ | People × doors matrix (always / time profile) | `0x50` |
| 2.5.1 Console → Check | ✅ | Dashboard: door state, counters, online/offline | `0x20`, `0x58`, `0x82` |
| 2.5.1 Adjust time | ✅ | Time synchronisation (manual + automatic) | `0x30`, `0x32` |
| 2.5.2 Upload | ✅ | Synchronisation with a **preview of the differences** | `0x50`, `0x52`, `0x5C`… |
| 2.5.3 Monitor | ✅ | Live monitor over WebSocket with photo | `0x20` events |
| 2.5.5 Download records | ✅ | Automatic incremental event collection by index | `0xB4`, `0xB0`, `0xB2` |
| 2.6 Records query | ✅ | Event history with filters + CSV export | — |
| 2.7.1 Operators/password | ✅ | Operators with roles + audit log | — |
| 2.7.2 DB backup | ✅ | Scheduled SQLite backup | — |
| 3.2.1 Record push-button events / 3.2.2 door events | ✅ | "Special events" flag | `0x8E` |
| 3.2.3 Time profiles (linked) | ✅ | Profiles 2–254, 3 segments, weekdays, validity, chaining | `0x88`, `0x98`, `0x8A` |
| 3.2.4 Peripherals (alarms) | ⚠️ partial | Inputs/alarms shown from status only; the known protocol does not expose alarm output configuration | `0x20` |
| 3.2.5 Keypad/PIN (card+PIN, door PIN, super password) | ✅ | Keypad activation, per-card PIN, up to 4 passcodes per door | `0xA4`, `0x8C`, `0x50` |
| 3.2.6 Anti-passback | ✅ | 5 modes | `0x84`, `0x86` |
| 3.2.7 Interlock | ✅ | 6 modes | `0xA2` |
| 3.2.8 Multi-card | ⚠️ | Only through the "enable/disable more cards" task (`more cards` count); group definitions are not part of the known protocol | `0xA8` |
| 3.2.9 First card open | ✅ | Per door: hours and active/inactive mode | `0xAA`, flag in `0x50` |
| 3.2.10 Task list | ✅ | 13 kinds of scheduled tasks | `0xA6`, `0xA8`, `0xAC` |
| 3.3.1 Remote open | ✅ | Open-door button (with confirmation and audit) | `0x40` |
| 3.4.1–3.4.3 Meal / Patrol / Meeting | ❌ | Out of scope for v1 | — |
| 3.4.4 One-to-more (lifts) | ❌ | Out of scope | — |
| 3.5.1 Operator/privilege management | ✅ | Admin/operator/read-only roles, per-zone restrictions | — |
| 4.x Attendance (shifts, holidays, leave, manual punches, reports) | ✅ | Attendance engine computed from swipe events on readers flagged "attendance" | — |
| 5.3 Import from Excel | ✅ (CSV) | CSV import (employee code, name, card, department with `\` separator) | — |

Additional function available in the protocol: **PC control** (`0xA0`: the controller delegates access decisions to the host and reverts to standalone mode after 30 s without communication) — offered only as an advanced option, disabled by default.

---

## 5. Communication protocol

### 5.1 Transport

| Aspect | Detail |
|---|---|
| Controller port | **UDP 60000** (also **TCP 60000** on recent firmware, same frames) |
| Size | Fixed **64 bytes** for both requests and responses; any other length is invalid |
| Model | 1:1 request/response. The controller replies to the request's **source address:port** → the client uses a socket with an ephemeral port and reads the reply there |
| Discovery | `0x94` with serial **0** sent as **broadcast** (`255.255.255.255:60000` or the subnet broadcast): every controller on the L2 segment replies |
| Unicast | Once the IP is configured, commands are sent directly to `IP:60000` (recommended: no broadcast, no multi-NIC issues) |
| Set IP (`0x96`) | **No reply**. After the command the controller only answers on the new IP → verify with a subsequent `0x94` |
| Pushed events | The controller sends `0x20` packets (same layout as Get Status) to the single configured **listener** (`0x90`: IPv4 + port + auto-send interval 0–255 s, 0 = on event only). Conventional host port: **60001** |
| Timeouts | No retransmission in the protocol. References: CLI 2.5 s; Node library 5 s. Ours: 2.5 s + 1 retry for idempotent operations, no automatic retry for non-idempotent writes (e.g. open door) |
| Ephemeral port trap | If the OS assigns port 60000 to the client socket, the client receives its own broadcast as if it were a reply → discard and bind again |

### 5.2 Frame structure

| Offset | Length | Field |
|---|---|---|
| 0 | 1 | Start of message **`0x17`** (exception: firmware **v6.62** sends listener events with **`0x19`**; accept it only when the function code is `0x20`) |
| 1 | 1 | **Function code** |
| 2 | 2 | Reserved (`00 00`) |
| 4 | 4 | Controller **serial number**, uint32 **little-endian** (0 for discovery) |
| 8 | 56 | Command-specific payload, zero-padded |

Official example (get controller, serial 405419896): `17 94 00 00 78 37 2a 18 00 …` (64 bytes).

### 5.3 Type encoding

| Type | Encoding |
|---|---|
| uint8/16/32 | little-endian |
| bool | `0x00` / `0x01` (other values = error) |
| **date** | 4 bytes BCD `YYYYMMDD` (e.g. `20 26 10 11`). `00000000` = absent |
| **datetime** | 7 bytes BCD `YYYYMMDDHHmmss`. All zeros = absent |
| shortdate (status) | 3 bytes BCD `YYMMDD` (century 20 implied) |
| time (status) | 3 bytes BCD `HHmmss` |
| HHmm | 2 bytes BCD `HHMM` |
| IPv4 | 4 bytes in network order (`c0 a8 01 64` = 192.168.1.100) |
| MAC | 6 bytes |
| version | 2 bytes BCD → `v8.92` from `08 92` |
| PIN | uint24 LE (3 bytes) in card records, uint32 LE in door passcodes; range 0–999999, 0 = none |
| magic | uint32 **`0x55AAAA55`** (bytes `55 aa aa 55`), required by destructive/configuration commands |

### 5.4 Command list (requests)

Offsets ≥ 8 (bytes 0–7 = header above).

| Code | Command | Request fields |
|---|---|---|
| `0x94` | Get controller (discovery) | — |
| `0x96` | Set IPv4 | 8 IP · 12 netmask · 16 gateway · 20 magic — **no reply** |
| `0x32` | Get time | — |
| `0x30` | Set time | 8 datetime |
| `0x92` | Get listener | — |
| `0x90` | Set listener | 8 IPv4 · 12 port u16 · 14 auto-send interval u8 |
| `0x82` | Get door control | 8 door |
| `0x80` | Set door control | 8 door · 9 mode (1 normally open, 2 normally closed, 3 controlled) · 10 delay in s (u8) |
| `0x8C` | Set door passcodes | 8 door · 12/16/20/24 passcodes 1–4 (u32, 0–999999) |
| `0x40` | Open door | 8 door |
| `0x20` | Get status | — |
| `0x58` | Get cards (count) | — |
| `0x5A` | Get card (by number) | 8 card number |
| `0x5C` | Get card at index | 8 index (from 1) |
| `0x50` | Put card | 8 card · 12 start date · 16 end date · 20–23 doors 1–4 (0 none, 1 always, 2–254 time profile) · 24 PIN (3 bytes) · 27 first-card bitmask (bit0 = door 1 … bit3 = door 4) |
| `0x52` | Delete card | 8 card |
| `0x54` | Delete all cards | 8 magic |
| `0xB0` | Get event | 8 index |
| `0xB4` | Get event index (last downloaded) | — |
| `0xB2` | Set event index | 8 index · 12 magic |
| `0x8E` | Record special events | 8 bool |
| `0x98` | Get time profile | 8 profile ID |
| `0x88` | Set time profile | 8 ID (2–254) · 9 start date · 13 end date · 17–23 Mon…Sun · 24/26 seg. 1 start/end · 28/30 seg. 2 · 32/34 seg. 3 (HHmm) · 36 linked profile (0 = none) |
| `0x8A` | Clear time profiles | 8 magic |
| `0xA8` | Add task | 8 start date · 12 end date · 16–22 Mon…Sun · 23 start time HHmm · 25 door · 26 task type · 27 "more cards" |
| `0xAC` | Refresh task list | 8 magic |
| `0xA6` | Clear task list | 8 magic |
| `0xA0` | Set PC control | 8 magic · 12 bool |
| `0xA2` | Set interlock | 8 mode |
| `0xA4` | Activate keypads | 8–11 reader 1–4 bool |
| `0x86` | Get anti-passback | — |
| `0x84` | Set anti-passback | 8 mode |
| `0xAA` | Set first-card | 8 door · 9 start time · 11 active mode · 12 end time · 14 inactive mode · 15–21 Mon…Sun |
| `0xC8` | Restore default parameters | 8 magic |

### 5.5 Responses

| Code | Response fields |
|---|---|
| `0x94` | 8 IP · 12 netmask · 16 gateway · 20 MAC · 26 version · 28 firmware date |
| `0x32`/`0x30` | 8 current datetime |
| `0x92` | 8 IPv4 · 12 port · 14 interval |
| `0x82`/`0x80` | 8 door · 9 mode · 10 delay |
| `0x58` | 8 number of cards (u32) |
| `0x5A`/`0x5C` | same layout as Put card (8–27). Card **0** = not found; card **0xFFFFFFFF** = deleted record (tombstone) |
| `0xB0` | 8 index · 12 type · 13 granted · 14 door · 15 direction · 16 card · 20 timestamp · 27 reason |
| `0xB4` | 8 index |
| `0x98` | same layout as Set time profile; ID 0 = not found |
| `0x86` | 8 anti-passback mode |
| all others | 8 `ok` bool |

### 5.6 Get Status / pushed event (`0x20`)

| Offset | Field |
|---|---|
| 8 | last event index (u32; 0 = no events) |
| 12 | event type |
| 13 | access granted (bool) |
| 14 | door (1–4) |
| 15 | direction (1 in, 2 out) |
| 16 | card number (u32) |
| 20 | event timestamp (datetime, optional) |
| 27 | reason code |
| 28–31 | door 1–4 sensor open |
| 32–35 | door 1–4 button pressed |
| 36 | system error |
| 37 | controller time HHmmss |
| 40 | sequence number (u32) |
| 48 | special info |
| 49 | **relays**: bitmask bit0–3 = door 1–4 (1 = unlocked) |
| 50 | **inputs**: bit0 = forced lock, bit1 = fire alarm |
| 51 | controller date YYMMDD |

### 5.7 Code tables

**Event type**: 0 none · 1 card swipe · 2 door · 3 alarm · 255 overwritten.

**Reasons**:

| Code | Meaning | Code | Meaning |
|---|---|---|---|
| 1 | swipe | 23 | door opened |
| 2 | swipe open | 24 | door closed |
| 3 | swipe close | 25 | door opened (supervisor password) |
| 5 | denied (managed by the system/PC control) | 28 | controller power on |
| 6 | no access rights | 29 | controller reset |
| 7 | incorrect password | 31 | push button invalid (door locked) |
| 8 | anti-passback | 32 | push button invalid (offline) |
| 9 | more cards (multi-card) | 33 | push button invalid (interlock) |
| 10 | first card open | 34 | push button invalid (threat) |
| 11 | door is normally closed | 37 | door open too long |
| 12 | interlock | 38 | forced open |
| 13 | not in allowed time period | 39 | fire |
| 15 | invalid timezone | 40 | forced closed |
| 18 | access denied | 41 | theft prevention |
| 20 | push button OK | 42 | 24×7 zone |
|  |  | 43 | emergency |
|  |  | 44 | remote open door |
|  |  | 45 | remote open door (USB reader) |

Codes not listed = reserved (show the numeric value).

**Door mode** (`0x80`/`0x82`): 1 normally open · 2 normally closed · 3 controlled.
**First-card mode** (`0xAA`, different encoding!): 0 controlled · 1 normally open · 2 normally closed · 3 first-card only (allowed only as the inactive mode).
**Interlock**: 0 none · 1 doors 1&2 · 2 doors 3&4 · 3 1&2 + 3&4 · 4 1&2&3 · 8 1&2&3&4.
**Anti-passback**: 0 disabled · 1 (1:2);(3:4) · 2 (1,3):(2,4) · 3 1:(2,3) · 4 1:(2,3,4).
**Task types** (`0xA8` byte 26): 0 door controlled · 1 normally open · 2 normally closed · 3 disable time profile · 4 enable time profile · 5 card only · 6 card + PIN on entry · 7 card + PIN · 8 enable more cards · 9 disable more cards · 10 trigger once · 11 disable push button · 12 enable push button.

### 5.8 Important semantics

- **Events** — circular buffer with a **monotonically increasing** index. When full, the controller discards ~2048 old events; reading an overwritten index returns type 255; an index past the last one returns index 0. The "event index" (`0xB4`/`0xB2`) is only a **bookmark** stored in the controller (the one used by the legacy software's "Download"); it does not delete anything. The app keeps its own `last_collected_index` in the database and treats the controller bookmark as information only.
- **Event reception = push + pull** — UDP pushes can be lost (UDP, server down, network): the index-based collector always fills the gaps (at startup, on reconnection, periodically and whenever a push reveals an index jump).
- **Door/button events** (reasons 20, 23, 24…) are recorded only when `0x8E` is enabled.
- **Cards** — there is no "update": `0x50` inserts or replaces. Reading all cards requires `0x58` (count) and `0x5C` by index until all valid cards are found, skipping `0xFFFFFFFF` tombstones (the scan can go beyond the count). With 20,000 cards ≈ 20,000 requests → synchronisation is **incremental** (diff from the database) and the full read is an explicit verification step.
- **Permissions** — per door: 0 none, 1 always, 2–254 = time profile ID (which must exist on the controller).
- **Time** — the controller has no NTP: the app synchronises its clock periodically (and when it comes back online), recording the drift.
- **Set IP** — no reply; in the worst case the controller ends up on an unreachable subnet → the UI asks for confirmation and verifies with discovery.
- **Restore defaults** (`0xC8`) — not verified on hardware by uhppoted: clears network, listener, events and cards. Admin only, with double confirmation.
- **PIN > 999999** — the controller does not reject it but stores it truncated → validated by the app.
- **Door delay** — u8 field: 0–255 s (the vendor advertises up to 600 s, which cannot be represented).

---

## 6. uhppoted ecosystem tools

| Tool | Role in the project |
|---|---|
| `uhppoted-codegen` → `models.json`, `test-data.json` | Specification and **35 official request/response vectors**: golden tests for our codec |
| npm `uhppoted` 0.9.1 | **devDependency**: differential tests (the same request encoded by our codec and by the library → identical bytes) |
| `uhppoted-simulator` (Docker `uhppoted/simulator`, REST :8000) | Emulates a UT0311-L04 (create devices, simulate swipes with door/direction/PIN, door open/close, push button; listener + auto-send; TCP). Used for integration tests. Note: v0.9.1 has no Windows build (v0.9.0 does) |
| `uhppoted-cli` (Windows zip) | Independent field diagnostics: `get-devices`, `get-status`, `listen`… with `--debug` it prints the packets → cross-check during hardware tests |
| `uhppoted-rest` / `-mqtt` / `-httpd` | Ready-made alternatives (Go gateways). Rejected as backend: one more service to run, no event push over REST, data model not ours. Still useful as a reference |

---

## 7. Evaluation of the npm `uhppoted` library and decision

### 7.1 Pros
MIT, zero dependencies, covers all 34 commands, supports TCP and the event listener, actively maintained (regular releases 2021→2026).

### 7.2 Defects verified in the 0.9.1 source
1. **Per-call UDP unicast ignored**: the address passed as `{id, address}` is used **for TCP only**; over UDP the destination comes exclusively from the `config.controllers` map, otherwise the request is **broadcast** (`driver.js` → `udp(c, …)` never receives `dest`).
2. **`config.bind` never used**: sockets always `bind(0)` on all interfaces → no control over the NIC on multi-interface hosts (typical of a NAS running Docker).
3. **Wrong relay bitmask**: `(byte & 0x02) === 1` is always false → relays 2–4 are always decoded as "locked" (`lookup.js`).
4. Numeric `isValidTaskType` accepts 1–13 and the encoder writes `task − 1` (undocumented 1-based convention); task 0 can only be selected by name.
5. Responses go through `JSON.stringify/parse` for internationalisation: every value is a "human" string (`'{{normally open}}'`), no TypeScript types.
6. No per-controller queue: concurrent requests open concurrent sockets to the same controller (the firmware handles parallelism poorly).

### 7.3 Decision
We implement a **`@uhppote-desk/protocol`** TypeScript package:
- `codec/` typed encoders/decoders for the 34 commands + event (layouts from `models.json`);
- `transport/` UDP (bind to a configurable interface IP, ephemeral port guarded against 60000, subnet broadcast) and TCP;
- `client` high-level API with a **serial queue per controller**, timeouts, retries only for idempotent operations;
- `listener` UDP event server that also accepts SOM `0x19`.

Quality is ensured by the official vectors (`test-data.json`), differential tests against `uhppoted`, the simulators and the official CLI in the field. The server only accesses the controllers through a `ControllerGateway`, so the implementation could be swapped if ever needed.

---

## 8. Network and deployment

| Scenario | Guidelines |
|---|---|
| **Docker on a NAS (production)** | `network_mode: host` (with a bridge network the broadcast does not leave the container and UDP events do not arrive without fragile port mappings). Variables: `UHPPOTE_BIND_ADDR` (IP of the NIC facing the controller), `UHPPOTE_BROADCAST` (e.g. `192.168.1.255:60000`), `UHPPOTE_LISTEN` (`0.0.0.0:60001`), `UHPPOTE_LISTENER_PUBLIC` (LAN IP of the server, written into the controller). Volume `/data` for SQLite and backups. Full guide: [docs/DOCKER.md](docs/DOCKER.md). |
| Development on Windows | `255.255.255.255` leaves through a single NIC (chosen by the routing table) → use the subnet broadcast and/or an explicit bind. Firewall: allow **inbound UDP on 60001** for `node.exe`. Docker Desktop on Windows does not really support `host` networking → for local tests use the native simulator or the FakeController (`npm run sim`). |
| Controller | Static IP in the same subnet as the server; the controller listener points to `SERVER_IP:60001`. If the controller is ever on a different subnet: no broadcast, unicast (or TCP) only, and a routing rule is needed for pushed events. |
| Security | The protocol has **no authentication or encryption**: anyone on the LAN can open the doors. A dedicated VLAN for the controller is recommended; the web app should be reachable only from the LAN/VPN, with HTTPS through a reverse proxy. |

---

## 9. Architecture

```
┌──────────── Browser (React + Vite + Mantine) ────────────┐
│  REST (TanStack Query)            WebSocket (live monitor)│
└───────────────┬───────────────────────────┬──────────────┘
                │                           │
┌───────────────▼───────────────────────────▼──────────────┐
│ apps/server (Fastify, TypeScript)                        │
│  auth (sessions, roles, audit) · REST API · WS hub       │
│  services: Sync (cards, configuration) · Events          │
│            (push + pull) · Health/TimeSync · Attendance  │
│            · Backup                                       │
│  db: SQLite (node:sqlite, SQL migrations)                │
│  ControllerGateway ─► @uhppote-desk/protocol             │
│                        client · codec · udp/tcp · listener│
└───────────────┬───────────────────────────▲──────────────┘
      UDP/TCP 60000 (commands)       UDP 60001 (pushed events)
                ▼                           │
          ┌─────────────── UT0311-L04 ──────┴─┐
          └───────────────────────────────────┘
```

**Monorepo (npm workspaces)**: `packages/protocol`, `packages/shared` (zod schemas, DTOs, enums and Italian labels for the codes), `apps/server`, `apps/web`, `tools/hwtest` (hardware test suite), `docker/`.

**Data model** (SQLite): controllers, doors, zones, departments, people, cards, permissions, time_profiles, tasks, controller_settings, events (unique per controller + epoch + index), shifts / holidays / leaves / manual_punches, operators, operator_zones, sessions, audit_log, sync_runs, settings.

**Principles**: the database is the source of truth for people/cards/permissions; the controller is a synchronised target with a preview of the differences. Every command sent to a controller goes through the gateway and is written to the audit log with operator, outcome and duration.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Controller firmware with undocumented differences | Hardware suite L1 reads the version; tolerant decoders; comparison with `uhppoted-cli --debug` |
| Lost UDP events | Index-based collector that fills gaps; push used only as a "fast notification" |
| Discovery fails (wrong NIC, firewall, Docker bridge) | Configurable bind and broadcast; host networking; dedicated L0 tests; fallback to direct IP |
| Two management systems on the same controller (single listener, conflicting syncs) | The UI shows the configured listener; documentation |
| Destructive commands (delete all, restore, set IP) | Admin only, double confirmation, automatic card backup before running |
| Cards whose printed number ≠ Wiegand-26 | Enrolment by swiping, validation facility ≤ 255 / number ≤ 65535 |
| LAN security | VLAN, HTTPS reverse proxy, roles, audit |

---

## 11. Test plan

### A. Unit (Vitest, no network)
- Encodings: BCD date/datetime/HHmm/shortdate, IPv4, MAC, version, uint24 PIN, magic.
- **Golden tests**: all 35 vectors from `test-data.json` (encoded request = expected bytes; decoded response = expected values).
- **Differential tests** against npm `uhppoted` for random valid inputs (property-based with fast-check).
- Wiegand-26 ↔ facility/number; validation (PIN, door 1–4, profile 2–254).
- Logic: card sync diff (additions, changes, removals, tombstones), event collection (gaps, type 255, restart), attendance engine (night shifts, holidays, leave, odd punch counts).

### B. Integration with simulators
Real UDP/TCP sockets against the FakeController and, optionally, the official uhppoted simulator (`docker/docker-compose.test.yml`): each client method is called and its effect read back (time, door control, listener, profiles, tasks, interlock, anti-passback, cards, open door). Simulated swipe → pushed event → database row → WebSocket message. Listener disabled → swipe → recovered by the collector. Simulator stopped → timeouts and errors handled.

### C. E2E (Playwright, against the FakeController)
Login per role (read-only users cannot open doors), create person + card → synchronisation → card present on the controller; the live monitor receives the swipe; every page opens without errors.

### D. Hardware test suite (`npm run hw -- --level N`, see the README for the procedure)
Guided and interactive where a physical action is needed; **non-destructive by default** (state saved and restored around writes, `--destructive` required for reset/delete-all); Markdown + JSON report in `reports/`.

| Level | Checks |
|---|---|
| **L0 Network** | host interfaces, ping of the controller IP, broadcast discovery (subnet and global), local UDP port, unicast UDP, TCP 60000, optional comparison with `uhppoted-cli` |
| **L1 Read-only** | get controller (S/N, IP, MAC, **firmware**, date), time + drift, status, listener, door control ×4, card count, event index, first/last event, anti-passback, latency |
| **L2 Safe writes** | set time + verification, listener pointed at the host + auto-send received, put/get/delete test card, time profile 254 set/get, door delay change + restore, special events, event bookmark |
| **L3 Physical** (prompted) | remote open of doors 1–4 (relay click), authorised/unauthorised card swipe → event with the correct reason, out-of-schedule access → reason 13, door sensor, exit button, keypad PIN |
| **L4 Robustness** | 100 consecutive requests, bulk load of cards (`--bulk`), cable unplugged → swipes stored offline → recovered by index, controller power cycle (reason 28), burst of swipes |
| **L5 Deployment** | L0–L2 run from the container on the server (host network) |

### E. Behaviour observed on the official uhppoted simulator (v0.9.0)

Running the client and the hardware suite against the Go simulator (an implementation independent of ours) revealed details that the app and the tests now take into account; they must be **re-confirmed on the real controller** (L2/L3):

| Observation | Consequence |
|---|---|
| Periodic **auto-send** to the listener starts only once at least one event is stored | Test L2.2 reports a warning (not a failure) if the controller has no events; reception is checked again in L3 |
| An unregistered card is denied with reason **18** ("access denied") rather than 6 | L3.6 accepts 6 or 18 and records the actual value in the report |
| `set-event-index` with an index beyond the last event replies `ok = false` | L2.7 uses an existing index |
| `set-first-card` (0xAA) is **not supported**: the simulator panics | Command covered by the official vectors and the FakeController; to be verified on the controller |
| The controller reports its own IP (even if different from the address it answers from) | L0.5 reports the mismatch (useful to detect NAT) |

---

## 12. Implementation status

Implemented following the architecture in §9, with one change from the original plan: instead of wrapping the npm `uhppoted` library behind an adapter, the codec and transport are our own (§7.3) and the library is used only as a reference in differential tests.

| Area | Status | Automated verification |
|---|---|---|
| Protocol (34 commands, UDP/TCP, listener, SOM 0x19) | ✅ | 70 golden tests on the official vectors, differential tests (≈ 2,000 random cases), integration with the FakeController and the uhppoted simulator |
| Controllers: discovery, IP, time, listener, diagnostics, factory reset | ✅ | server integration + E2E |
| People, cards (lost card, enrolment by swipe, CSV import), permissions, synchronisation with preview | ✅ | server integration + E2E |
| Events: push + collection by index, gap recovery, epochs after a controller reset, WebSocket monitor, history, export | ✅ | server integration + E2E |
| Time profiles, tasks, doors, interlock, anti-passback, keypads, door passcodes, first card, special events, PC control | ✅ | server integration |
| Attendance: shifts (including night shifts), holidays (including Easter), leave/absences, manual punches, report + CSV | ✅ | unit |
| Operators with roles and zones, audit log, daily backup | ✅ | server integration + E2E |
| Hardware commissioning suite L0–L5 | ✅ | run against the FakeController (all levels) and the uhppoted simulator (L0–L2) |
| Docker image | ✅ | built, smoke-tested and published by GitHub Actions |

Not included in v1 (see §4): meal, patrol, meeting, lifts, alarm output configuration, multi-card group definitions, migration from the legacy database.

---

## 13. Open questions (to be answered once the controller is available)

1. Actual firmware version (determines SOM `0x19`, TCP support, known bugs).
2. Installed readers: Wiegand-26 only? With keypad (for PIN / card + PIN)?
3. Door sensors and exit buttons wired on all 4 doors?
4. Addressing: server subnet and static IP to assign to the controller.
5. Possible data migration from the legacy software (`iCCard3000.mdb`, password `168168`) — out of scope for v1, feasible as an import.
