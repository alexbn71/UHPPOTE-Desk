# Alarm expansion board (UT0311-01A)

The UHPPOTE **UT0311-01A** alarm expansion board (sold by the OEM as **ACM-EC05**, Amazon ASIN B00UX02NDY) is an
add-on for the UT0311-L0x controllers with **four alarm relays** and a **fire input**. It switches a siren, a warning
light or a signal to a burglar/fire panel when something happens at the doors: duress code, door open too long,
forced open, forced lock, invalid card, fire alarm.

UHPPOTE Desk configures it from *Controllers → (controller) → Expansion board*.

> **Experimental.** The commands for the board are not part of the public controller protocol (uhppoted does not
> support them). They were reconstructed from the manufacturer's Windows software for interoperability; no
> manufacturer code is included in UHPPOTE Desk. Verified so far on one UT0311 controller with firmware v9.f8
> (write with `0xF2`, address mapping, read-back of the parameter table); the behaviour of the relays still has to
> be confirmed with a board connected ([hardware tests](#hardware-tests-level-6)).

## Using it

1. Connect the board to the controller following the leaflet in the box and power it from the controller supply
   (12 V DC).
2. In *Expansion board* turn on **Expansion board connected**. Only then is the configuration written to the
   controller: controllers without the board are never touched.
3. Configure the outputs and press **Save and send to the controller**. UHPPOTE Desk writes the configuration and
   then **reads it back from the controller**: the message says whether the controller stores exactly what was sent.
   The configuration is written again by *Synchronisation → Full synchronisation*.
4. **Read from the controller** shows what the controller really stores (read only): the four outputs, the
   open-too-long time, the duress code and the alarm types, with a badge saying whether it matches the saved
   configuration. *Copy into the form* takes that configuration as a starting point (for example one made with the
   manufacturer's software); save to apply it.

| Setting | Meaning |
|---|---|
| Door open too long after | seconds after which a door left open raises *Door open too long* (event 37). Default 25 s |
| Duress code | code typed on the PIN keypad under threat: the door opens and the *duress* alarm is raised. Empty = the code stored in the controller is not changed |
| Door open too long raises an alarm | without it a door left open is only recorded; with it, it is an alarm that can drive the outputs (vendor *Activate Open Too Long Warn*, firmware V6.58+) |
| Invalid card alarm only after 3 attempts | the *invalid card* alarm after 3 invalid swipes in a row instead of every one (vendor *Activate Invalid 3 Cards Warn*, firmware V8.96+) |
| Duress code only after a registered card | the duress code counts only right after the swipe of a registered card (vendor *Threat Code Valid After Registered Card Swipe*) |
| Output N → Active | the relay is used; an inactive relay is written as all zeros |
| Triggering source | door 1–4, or the burglar alarm (ARM, experimental) |
| Output mode | see below |
| Triggering events | duress code, open too long, forced open, forced lock, invalid card, fire alarm |
| Signals | only for the *any/all signals* modes: door lock relay, door sensor, exit button, force lock input, board inputs A1–A3, board fire input |
| Output duration | seconds (0–6553) for the timed modes |

| Output mode | The relay stays on… |
|---|---|
| 1 · For the output duration | for the set time |
| 2 · For the duration and until reset | at least for the set time and until the cause is gone |
| 3 · Until the event is reset | until the cause is gone (e.g. the door is closed again) |
| 4 · Any signal | while at least one of the selected signals is active |
| 5 · All signals | while all the selected signals are active |

The defaults offered for a new output are those of the manufacturer: output N follows door N on duress, open too
long, forced open and fire, for 10 seconds.

The alarms appear in the monitor, history, webhooks, MQTT and rules as the events the controller already sends:
37 *door open too long*, 38 *forced open*, 39 *fire*, 40 *forced closed*. *Forced open* needs a door sensor; the
duress code needs a reader with a PIN keypad (*Advanced settings → Keypads*).

### Limits

- **Reading back** uses the manufacturer's older long-packet protocol over UDP (the 64-byte protocol has no read
  command for the parameter table). On a firmware that does not answer it, the configuration is still written, but
  the save reports that it could not be verified.
- A configuration made with the manufacturer's software is replaced at the next save: use *Read from the
  controller → Copy into the form* first to keep it.
- **Before removing the board**, deactivate the outputs and save: turning off *Expansion board connected* only
  stops UHPPOTE Desk from writing, it does not clear what is already in the controller.
- **Burglar alarm (ARM)** uses the manufacturer's default control mode (126) and arm/disarm delays (30 s); how it
  is armed and disarmed has not been verified.
- **Resetting an alarm output** from the application is not supported: the manufacturer's software does it with
  its long-packet protocol (type 0x20, code 0xA0), not implemented yet.
- Whether the controller reports the state of the board relays in the status packet is unknown: the hardware tests
  log the raw *relays* and *inputs* bytes to find out.

## Protocol

### 0xF2 — write parameters

A 64-byte request with the standard header (`0x17`, function `0xF2`, serial number at offset 4):

| Offset | Content |
|---|---|
| 8–11 | magic word `55 AA AA 55` |
| 12 + 3·k (k = 0…7) | `address` (uint16 little-endian), `value` (uint8) — up to 8 bytes of the parameter table per packet; address 0 = unused |

`address` = *index in the parameter table* + 16. The reply has byte 8 = 1 on success. Writes are idempotent and
applied immediately; UHPPOTE Desk sends the bytes in ascending order, 8 per packet. Verified on firmware v9.f8: a
byte written with `0xF2` is found in the table read back, and the controller also updates bytes 510–511 (apparently
a checksum of the table). Hardware tests L6.3 and L6.4 check it on any controller.

The manufacturer's software does not use `0xF2` on this firmware: it writes the whole table with a long packet
(type `0x24`, code `0x20`, 1172 bytes = 20-byte header + 1024-byte table + 128-byte mask of the bytes to update).
The network configuration in that table (bytes 384–395) is not changed by such a write.

### Reading the parameter table (long packet 0x24 / 0x10)

The request is 20 bytes, all little-endian:

| Offset | Content |
|---|---|
| 0, 1 | type `0x24`, code `0x10` |
| 2–3 | CRC-16/ARC (poly 0x8005 reflected, init 0) of the 20 bytes with these two at 0 |
| 4–7 | transaction id (echoed in the reply) |
| 8–11 | sender serial: 0 |
| 12–15 | recipient serial, or `0xFFFFFFFF` = any controller |
| 16, 17, 18, 19 | 0, `0x81`, 2, 0 |

The reply (type `0x24`, code `0x11`, 1044 bytes) has the same header — CRC over all 1044 bytes, sender = the
controller serial — followed by the 1024-byte table (bytes 0–1 are the markers `0D 7E`). UHPPOTE Desk builds the
request byte-for-byte like the manufacturer's software (checked against its captured packets). The code is in
[packages/protocol/src/codec/long.ts](../packages/protocol/src/codec/long.ts); the client method is
`readParameters` / `readExpansionBoard`.

### Parameter table bytes used by the board

Four relay blocks of 6 bytes at index **136 + 6·n** (n = 0…3 → outputs 1–4):

| Offset | Field | Values |
|---|---|---|
| +0 | source | 0–3 = door 1–4 (door index: the manufacturer's software writes 3 for door 4), 16 = ARM. Factory values seen in a new controller: 1, 2, 4, 16 with all outputs inactive |
| +1 | output mode | 0 = inactive, 1–5 (table above) |
| +2 | events (bitmask) | 0x01 duress · 0x02 open too long · 0x04 forced open · 0x08 forced lock · 0x10 invalid card · 0x20 fire |
| +3 | signals (bitmask) | 0x01 lock relay [NC] · 0x02 door sensor [NC] · 0x04 exit button [NO] · 0x08 force lock [NO] · 0x10/0x20/0x40 inputs A1–A3 [NC] · 0x80 fire input [NO] |
| +4…+5 | output duration | uint16 LE, tenths of a second |

Other bytes written (indexes 384–395 hold the controller IP address, netmask and gateway; UHPPOTE Desk never
writes them with `0xF2`):

| Index | Meaning | Written value |
|---|---|---|
| 30 | record alarm events | 1 |
| 32 | alarm types handled by the controller (bitmask as *events*, + 0x40 ARM) | union of the events of the active outputs, plus 0x08 and 0x20 (always set by the manufacturer's software), plus 0x40 if an output uses ARM |
| 35 + 162 | door open too long, tenths of a second (low byte at 35, high byte at 162) | setting × 10 |
| 45, 46, 47 | ARM control mode, arm delay, disarm delay | 126, 30, 30 — only if an output uses ARM |
| 74, 75, 163 | duress code (24-bit: 74 low, 75 middle, 163 high) | only if set |
| 32, bit 0x80 | the duress code counts only after a registered card | with *Duress code only after a registered card* |
| 245 | invalid swipes in a row before the *invalid card* alarm (0 = every swipe) | 3 with *Invalid card alarm only after 3 attempts*, otherwise 0 |
| 252 | *door open too long* is an alarm | `0xA5` with *Door open too long raises an alarm*, otherwise 0 |

The code is in [packages/protocol/src/codec/expansion.ts](../packages/protocol/src/codec/expansion.ts); the
encoder and its tests are in `encode.writeParameters` and
[packages/protocol/test/expansion.test.ts](../packages/protocol/test/expansion.test.ts). The FakeController keeps
the parameter table, answers the long-packet read (`longPackets = false` simulates a firmware without it) and
simulates the relays (`raiseAlarm`, `setFireInput`, `expansionOutputs`).

### Function codes not used

The open uhppoted issue [#87](https://github.com/uhppoted/uhppoted/issues/87) lists `0xAE` set-warnings, `0xC0`
reset-alarm-output and `0xC2` get-alarm-status, without packet layouts. UHPPOTE Desk does not use them; hardware
test L6.1 only *probes* `0xC2` (read-only) and saves the raw reply in the report.

## Hardware tests (level 6)

Level 6 of `npm run hw` checks the board on a real controller. It is not in the default levels and it
**overwrites the expansion board configuration**: at the end all the outputs are left inactive; save the
*Expansion board* tab again (or run a full synchronisation) to restore yours.

```bash
# without the board: probe, table read, address mapping and configuration write (L6.1–L6.4)
npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 6 --only L6.1,L6.2,L6.3,L6.4

# with the board connected and something on its relays (LED, buzzer, tester)
npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 6

# also the duress code test (changes the duress code, which cannot be read back)
npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 6 --destructive
```

| Test | What it checks | Needs |
|---|---|---|
| L6.1 | probe of `0xC2` get-alarm-status; the raw reply goes into the report (warning if unsupported) | — |
| L6.2 | **reads the parameter table** (long packet); its door bytes 2–13 must match `get-door-control`; the four output blocks go into the report | — |
| L6.3 | address mapping: writes the door 1 open delay in parameters 2–3 with `0xF2`, finds it in the table read back, restores it. A warning means `get-door-control` does not reflect it immediately | — |
| L6.4 | the configuration (all outputs inactive) is written, read back identical, and doors, listener, anti-passback and network are unchanged | — |
| L6.5 | output 1 on **forced open** of door 1 (event 38) | board, door sensor on door 1 |
| L6.6 | output 2 on **door open too long** (5 s, *until reset*, with *Door open too long raises an alarm*): on while open, off after closing | board, door sensor on door 1 |
| L6.7 | output 3 on an **invalid card** at door 1 | board, an unregistered card |
| L6.8 | **fire input** of the board: fire flag/event 39, doors released, output 4, flag cleared afterwards | board |
| L6.9 | **duress code** on the door 1 keypad (output 1); logs the events the controller sends | board, PIN keypad, `--destructive` |

Before every physical test the configuration is read back: the test does not start if the controller did not
store it.

Every test logs the raw *relays* and *inputs* bytes of the status at the moment of the alarm: send the report
(`reports/hwtest-*.md` and `.json`) when something does not behave as described here.

The whole level also runs against the FakeController in `tools/hwtest/test/hwtest.int.ts` (`npm run test:int`).

## Capturing with Wireshark

A capture of the manufacturer's software configuring the board is the reference for the reconstructed protocol:
it shows whether it uses `0xF2` with the same bytes as UHPPOTE Desk, or its older long-packet protocol.

### Setup

1. Install [Wireshark](https://www.wireshark.org) (with Npcap).
2. Copy [tools/wireshark/uhppote.lua](../tools/wireshark/uhppote.lua) to `%APPDATA%\Wireshark\plugins\`
   (Linux/macOS: `~/.local/lib/wireshark/plugins/`) and restart Wireshark, or *Analyze → Reload Lua Plugins*
   (Ctrl+Shift+L).
3. Capture on the network card that reaches the controller (e.g. *Ethernet*) with the capture filter
   `udp port 60000 or udp port 60001`, and use the display filter `uhppote`.

The dissector names every function, decodes status and events (door, card, reason, relay and input bytes) and,
for `0xF2`, every byte written: `[138] = 0x14 expansion output 1: events = forced open, invalid card`.
Packets of a size other than 64 bytes are the manufacturer's long-packet protocol: the parameter table read
(`0x24/0x10`, reply `0x11`) and write (`0x24/0x20`, with the number of bytes marked for update) are decoded, the
others show only their header.
The listener port (default 60001) can be changed in *Edit → Preferences → Protocols → UHPPOTE*.

### Capturing the manufacturer's software

> **Careful.** The manufacturer's *Upload* sends its whole configuration to the controller, including its own
> card list and time profiles. Use a controller without production data, or run *Synchronisation → Full
> synchronisation* in UHPPOTE Desk afterwards to restore cards, profiles and settings. Do not run the two
> programs against the controller at the same time.

1. Install the manufacturer's software (`MJ_all_en.rar`, *AccessControl*), log in (`abc` / `123`) and add the
   controller.
2. Enable *Peripheral control* in the extended functions (password `5678`).
3. Start the capture in Wireshark.
4. *Configuration → Peripheral → Hardware Configuration*: configure the terminal blocks (for example block 1 =
   door 1, *Forced Open*, 20 s), confirm with *OK*, then *Operation → Console → Upload* to the controller.
5. Stop the capture and save it as `.pcapng`.
6. Enter the same configuration in the *Expansion board* tab of UHPPOTE Desk and save it as `expected.json`
   (the `expansionBoard` object of `GET /api/controllers/<id>/settings`), then compare:

```bash
npm run pcap -- capture.pcapng                           # functions, writes (0xF2 and long), reconstructed board
npm run pcap -- capture.pcapng --expected expected.json  # IDENTICAL, or the bytes that differ (exit code 2)
npm run pcap -- capture.pcapng --json analysis.json      # the same, as JSON
```

`npm run pcap` needs `tshark` (installed with Wireshark; set `TSHARK` if it is not in
`C:\Program Files\Wireshark`). Writes made by the manufacturer's software with its long packet are taken from the
update mask; the last table read in the capture is shown too. Bytes reported as *extra* are written by the
manufacturer's software but not by UHPPOTE Desk (it writes much more of the table).

Captures of the hardware tests are useful too: start Wireshark, run `npm run hw -- … --level 6` and attach the
`.pcapng` to the report.
