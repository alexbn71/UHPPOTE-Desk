# Home Assistant integration (MQTT)

UHPPOTE Desk can publish its controllers and doors to an MQTT broker using **Home Assistant MQTT discovery**: the devices appear in Home Assistant by themselves, with live door states, access events for automations and *Open* buttons. No custom component is needed.

## Requirements

- An MQTT broker reachable from the UHPPOTE Desk server, e.g. the **Mosquitto broker** add-on of Home Assistant, or Mosquitto in Docker.
- The **MQTT** integration configured in Home Assistant, with discovery enabled (the default).

## Setup

1. In the broker, create a user for UHPPOTE Desk. With the Mosquitto add-on: *Settings → People → Users → Add user* (e.g. `uhppote-desk`). Any Home Assistant user can log in to the add-on.
2. Set the variables of the UHPPOTE Desk container and restart it:

   ```env
   MQTT_URL=mqtt://192.168.1.20:1883
   MQTT_USERNAME=uhppote-desk
   MQTT_PASSWORD=…
   MQTT_LANGUAGE=it        # entity names in Italian (en, it, es, fr, de)
   ```

   The full list is in [DOCKER.md](DOCKER.md#home-assistant-mqtt).
3. Check *System → Home Assistant (MQTT)* in UHPPOTE Desk: the status must be **connected**.
4. In Home Assistant, open *Settings → Devices & services → MQTT*: one device per controller and one per door appear.

Adding, renaming, disabling or deleting controllers and doors in UHPPOTE Desk updates Home Assistant automatically. Inactive doors and disabled controllers are removed from Home Assistant.

## What appears in Home Assistant

**Controller** device (name and firmware from UHPPOTE Desk):

| Entity | Type | Meaning |
|---|---|---|
| Connectivity | binary sensor (diagnostic) | Controller reachable |
| Fire alarm | binary sensor (`safety`) | Fire alarm input active |
| Forced lock | binary sensor | Forced lock active |
| Problem | binary sensor (diagnostic) | Controller reports a system error (code in the attributes) |
| Clock drift | sensor (diagnostic, disabled by default) | Controller clock difference, seconds |

**Door** device (one per active door, linked to its controller):

| Entity | Type | Meaning |
|---|---|---|
| Door | binary sensor (`door`) | Door sensor: on = open |
| Lock | binary sensor (`lock`) | Relay: on = **unlocked** |
| Open | button | Opens the door (the relay is released for the door's delay). Only with `MQTT_DOOR_CONTROL=true` |
| Access | event | Fires on each event of the door, see below |
| Last access | sensor | Name of the last person who swiped (or the card number); attributes: card, granted, direction, reason, time |
| Exit button | binary sensor (disabled by default) | Exit button pressed |

When the controller is offline, its entities become *unavailable*; when UHPPOTE Desk stops, all of them do.

### Access events

The *Access* event entity has four event types:

| `event_type` | When |
|---|---|
| `granted` | Card swipe, access granted |
| `denied` | Card swipe, access denied (unknown card, no permission, outside the time profile…) |
| `door` | Door events: remote opening, exit button, door opened/closed (the last two only when the controller records special events) |
| `alarm` | Alarms: door open too long, forced open or closed, fire, theft prevention, 24×7 zone, emergency, exit button under threat |

Attributes: `person`, `personId`, `card`, `granted`, `direction` (`in`/`out`), `reason` (text in `MQTT_LANGUAGE`), `reasonCode`, `timestamp`.

Only recent events (last 10 minutes by the controller clock) fire the entity: when a controller comes back online and its stored events are downloaded, Home Assistant is not flooded with old swipes. They are still published on the `<serial>/event` topic.

## Example automations

Notify on a denied card:

```yaml
alias: Denied card at the entrance
triggers:
  - trigger: state
    entity_id: event.entrance_door_1_access
conditions:
  - condition: state
    entity_id: event.entrance_door_1_access
    attribute: event_type
    state: denied
actions:
  - action: notify.mobile_app_phone
    data:
      message: >
        Denied card {{ trigger.to_state.attributes.card }}:
        {{ trigger.to_state.attributes.reason }}
```

Turn on the hall lights when a specific person comes in after dark:

```yaml
alias: Welcome lights
triggers:
  - trigger: state
    entity_id: event.entrance_door_1_access
conditions:
  - condition: template
    value_template: >
      {{ trigger.to_state.attributes.event_type == 'granted'
         and trigger.to_state.attributes.personId == 12 }}
  - condition: sun
    after: sunset
actions:
  - action: light.turn_on
    target:
      entity_id: light.hall
```

Open the gate from an automation or a dashboard: call `button.press` on the door's *Open* button.

The entity ids depend on the device names: check them in *Settings → Devices & services → Entities*.

## Security

- Whoever can publish on the broker can open the doors through `…/door/<n>/open`. Give the broker authentication, and with Mosquitto restrict the `uhppote-desk/+/door/+/open` topics with an ACL to the Home Assistant user and UHPPOTE Desk.
- To publish states and events without allowing openings, set `MQTT_DOOR_CONTROL=false`: the *Open* buttons are removed and the commands are ignored (with a warning in the log).
- Every opening from MQTT is recorded in the audit log (*open-door*, details `source: mqtt`).
- For a broker outside the local network use `mqtts://`.

## Topics

For Node-RED or other systems; `<base>` is `MQTT_BASE_TOPIC` (default `uhppote-desk`), `<serial>` the controller serial number, `<n>` the door number 1–4.

| Topic | Retained | Content |
|---|---|---|
| `<base>/status` | yes | `online` / `offline` (last will) |
| `<base>/<serial>/availability` | yes | `online` / `offline` of the controller |
| `<base>/<serial>/state` | yes | JSON: `online`, `lastSeenAt`, `controllerTime`, `driftSeconds`, `forceLock`, `fireAlarm`, `systemError`, `doors: { "1": { open, unlocked, button }, … }` |
| `<base>/<serial>/event` | no | Every event stored by UHPPOTE Desk, JSON (same fields as the events API) |
| `<base>/<serial>/door/<n>/event` | no | Recent events of the door, JSON with `event_type` (see above) |
| `<base>/<serial>/door/<n>/last_access` | yes | Last card swipe of the door, JSON |
| `<base>/<serial>/door/<n>/open` | — | **Command**: any payload opens the door |

Discovery configs are published under `<MQTT_DISCOVERY_PREFIX>/<component>/uhppote_desk/<id>/config`, and are published again when Home Assistant restarts (`homeassistant/status` = `online`).

## Troubleshooting

| Symptom | Solution |
|---|---|
| *System* shows "not connected", log `MQTT: broker … unreachable` | Check host and port in `MQTT_URL`; the broker must be reachable from the UHPPOTE Desk server (with the Mosquitto add-on, port 1883 on the Home Assistant IP) |
| Log `MQTT: Connection refused: Not authorized` | Wrong `MQTT_USERNAME`/`MQTT_PASSWORD` |
| Connected but no devices in Home Assistant | Discovery prefix different from `homeassistant`, or discovery disabled in the MQTT integration options |
| Entities *unavailable* | The controller is offline (check *Controllers*), or UHPPOTE Desk is stopped |
| The *Open* button does nothing | `MQTT_DOOR_CONTROL=false`, the door is inactive, or the controller does not reply: see the log (`MQTT: opening door … failed`) and the audit log |
| Old devices remain after changing `MQTT_BASE_TOPIC` or `MQTT_DISCOVERY_PREFIX` | Delete them from Home Assistant (*Device → Delete*). Otherwise stale devices are removed automatically at every connection |
