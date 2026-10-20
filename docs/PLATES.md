# Licence plates

UHPPOTE Desk can open a gate for known vehicles. A camera with plate recognition (tested with **AgentDVR**) sends every plate it reads; UHPPOTE Desk decides whether the vehicle may enter, opens the door, takes a photo from the camera and records the reading. No Node-RED or other glue is needed.

```
Camera ──video──► AgentDVR (plate recognition) ──"Call URL"──► UHPPOTE Desk ──► controller ──► gate
                        ▲                                          │
                        └──────── list of known plates ◄───────────┘
                                                                   └── photo: AgentDVR grab.jpg
```

## Who may enter

Plates belong to **people** or to **guest passes**:

- **People**: *Registry → People → (person) → Plates*. The vehicle passes the doors where the person has a **permission**, within the permission's **time profile** (checked by UHPPOTE Desk with the same rules as the controller: validity dates, weekdays, segments, linked profile). The person must be active and within their validity dates. A plate can be given to several people (a shared company car).
- **Guests**: the *Vehicle plates* field of a [guest pass](GUESTS.md). The vehicle passes the doors of the pass while the pass is active (period, days and hours, maximum openings). An opening by plate counts towards the maximum openings and shows in the pass history.

Plates are compared ignoring spaces, dashes and the characters that readers confuse most: B/8, O/0, I/1, Z/2, S/5 (`AB123CD` matches a reading `A8123CD`).

## Cameras

Administrators add the cameras in *Operations → Licence plates → Cameras*:

| Field | Meaning |
|---|---|
| **Name** | Shown in the readings and in the audit log (`plate:<name>`) |
| **Door** | The door opened for authorised plates |
| **Photo address** | A still image taken at every reading. AgentDVR: `http://<server>:8090/grab.jpg?oid=<camera id>&size=1920x1080` (without `size` the image is 320×240). Empty = no photo |
| **Pause after an opening** | Seconds during which the camera's readings are ignored after an opening, because the car is still in front of it (default 30). Refused plates are recorded once per pause (at least 10 s) |
| **Open the door** | Off = the readings are only recorded: useful to test a new camera without opening the gate |
| **Enabled** | Off = the camera's calls are refused |

After saving, UHPPOTE Desk shows **two addresses** that contain the camera's secret key. Copy them into AgentDVR right away: the key is shown only once (only its hash is stored). *New key* replaces it; the old addresses stop working.

Set **Address of UHPPOTE Desk** to the address AgentDVR uses to reach UHPPOTE Desk, e.g. `http://192.168.178.61:8080`. If AgentDVR runs in Docker, use the IP address, not a host name.

The camera ID (`oid`) is shown in AgentDVR, or in `http://<server>:8090/command.cgi?cmd=getObjects` (`"id"` of each camera).

## Setting up AgentDVR

AgentDVR raises the "plate recognised" event only for the plates in its own list, so the list is given by UHPPOTE Desk:

1. **Camera → Edit → AI → LPR (license plate recognition)**:
   - *Plates*: the first address, `http://<UHPPOTE Desk>/api/plates/agentdvr.csv?key=uhp_…`
   - *Reload interval*: 60 seconds (a new plate is known to AgentDVR within a minute)
   - *Mode*: alert
2. **Camera → Edit → Actions → Add**:
   - *If*: `AI: License Plate Recognized`
   - *Then*: `Call URL`
   - *URL*: the second address, `http://<UHPPOTE Desk>/api/plates/read?key=uhp_…&plate={AI}`
3. Optional: the same action on `AI: License Plate Not Recognized`, so that unknown vehicles are recorded (and notified) too.

`{AI}` may contain several readings and object labels separated by commas: UHPPOTE Desk takes the readings with at least 5 letters or digits including a digit, and uses the first one that belongs to someone.

Other systems can call the same endpoint: `GET` or `POST /api/plates/read` with `key` and `plate` in the query string or in a JSON body, or the key in an `X-Reader-Key` header. The reply is `{ "outcome": "granted", "opened": true, "plate": "AB123CD", "ignored": false }`.

## Readings

*Operations → Licence plates → Readings* lists every reading: photo (click to enlarge), time, plate and what the camera sent, owner, outcome and camera. Filters: granted / refused, plate or name.

| Outcome | Meaning |
|---|---|
| Granted | The door was opened (or, with *Open the door* off, it would have been: "not opened") |
| Unknown plate | No person or guest has this plate |
| Person not active | The person is disabled or outside their validity dates |
| No permission on the door | The owner has no permission on the camera's door |
| Outside the time profile | The permission's time profile does not allow this moment |
| Pass not yet valid / outside hours / expired / used up / blocked / revoked | The guest pass cannot be used now |
| Controller error | The door could not be opened; the next reading tries again |

Openings also appear in the audit log as `plate-open-door` and in the event history as the controller's remote opening. **Persons inside** counts a vehicle let in on an entry door like a card swipe (the plate is shown instead of the card).

### Photos

Photos are kept in `<DATA_DIR>/plates` for **30 days** by default; the readings themselves are kept. Change it with the `PLATE_PHOTO_DAYS` variable (`0` = no photos are taken). Photos of vehicles and people are personal data: keep only what you need and inform the people concerned.

## Notifications, webhooks and rules

| Type | When |
|---|---|
| `plate.granted` | A plate was let in (or would have been, in "record only" mode: `opened` is false) |
| `plate.denied` | A plate was refused or the opening failed |

**Telegram** and **email** notifications include the photo. The webhook `data` is:

```json
{
  "readId": 42,
  "plate": "AB123CD",
  "ownerName": "Rossi Mario",
  "personId": 12,
  "guestPassId": null,
  "outcome": "granted",
  "opened": true,
  "reader": "Gate camera",
  "timestamp": "2026-10-20 08:01:12",
  "photoPath": "/api/plates/reads/42/photo"
}
```

`photoPath` needs a login or an API token. In [rules](RULES.md) the person conditions match the owner of the plate, `{person}` is the owner's name and `{plate}` the plate.

## Moving from the Node-RED flow

The Node-RED flow "Cancello targhe" did the same with `TARGHE_AUTORIZZATE`. To move:

1. Add the plates to the people (or guest passes) and check their permission on the gate.
2. Create the camera in UHPPOTE Desk and replace, in AgentDVR, the *Plates* list address and the *Call URL* of the action with the two new addresses.
3. In Node-RED keep only the day/night profile of the camera; the `/targa` and `/targhe.csv` nodes are no longer needed.
