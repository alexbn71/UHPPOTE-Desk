# API tokens

API tokens let other systems and scripts use the UHPPOTE Desk API without an operator login: CasaAuto opening the gate, n8n or Node-RED reading events, an HR system creating people and cards, a monitoring script checking the controllers.

They are managed by administrators in *Administration → API tokens*.

## Creating a token

1. *New token*: give it the name of the system that will use it (it appears in the audit log as `token:<name>`).
2. Choose the **access level** and, if needed, the restrictions:

   | Access level | Can do |
   |---|---|
   | **Read-only** | Every read: controllers and live state, doors, events, people, cards, attendance, the `/api/ws` live feed |
   | **Read + door opening** | Read-only, plus `POST /api/doors/:id/open` |
   | **Operator** | Like an operator: people, cards, permissions, attendance, door opening, synchronisation |
   | **Administrator** | Like an administrator, except managing operators and API tokens |

   - **Restrict to zones**: as for operators, door opening and synchronisation only on the controllers of those zones (sub-zones included).
   - **Doors that can be opened**: only these doors (empty = all, within the zones). This is the right choice for a device that must open one gate only.
   - **Expires on**: last valid day; empty = no expiry.
3. Save and **copy the token**: it starts with `uhd_` and is shown only once. UHPPOTE Desk keeps only its SHA-256 hash; if it is lost, create a new token and delete the old one.

The list shows the first characters of each token, its restrictions, and when and from which IP it was last used. Disable or delete a token to revoke it immediately.

Tokens can never manage tokens or operators, nor change passwords (`403`, code `tokenNotAllowed`): those operations require an administrator logged in with a password.

## Using a token

Send it in the `Authorization` header of every request:

```bash
curl -H "Authorization: Bearer uhd_…" http://192.168.1.10:8080/api/doors
```

- A missing, wrong, disabled or expired token gives `401` (`unauthenticated`); an operation outside the token's rights gives `403` (`forbidden`, `zoneForbidden`, `doorForbidden`).
- Errors have the form `{ "error": "<English text>", "code": "<code>", "params": {…} }`.
- Every change and every door opening made with a token is in the audit log, as `token:<name>`.
- Publish UHPPOTE Desk over HTTPS (reverse proxy) when a token travels outside the local network.

## Main endpoints

All under `/api`. Bodies and replies are JSON.

| Method and path | Minimum level | Description |
|---|---|---|
| `GET /doors` | read | Doors: `id`, `controllerId`, `door` (1–4), `name`, `active`, `mode`, `delay` |
| `POST /doors/:id/open` | read + doors | Opens a door (`:id` from `GET /doors`) |
| `GET /controllers` | read | Controllers, with `online` and their doors |
| `GET /controllers/live` | read | Live state: online, door open/unlocked, alarms |
| `GET /events?from=&to=&door=&personId=&card=&granted=&limit=&offset=` | read | Event history (`from`/`to` as `YYYY-MM-DD HH:mm:ss`), newest first |
| `GET /events/export.csv` | read | Same filters, as CSV |
| `GET /people?search=` / `GET /people/:id` | read | People |
| `POST /people` / `PUT /people/:id` | operator | Create or change a person (`code`, `lastName`, `validFrom`, `validTo`, …) |
| `GET /cards` / `POST /cards` | read / operator | Cards; create with `{ "number": 10058400, "personId": 12 }` |
| `PUT /people/:id/permissions` | operator | Door permissions of a person |
| `GET /attendance/report?from=&to=` | read | Attendance report |
| `POST /punches` | operator | Manual punch |
| `GET /system/info` | read | Version, counts, network settings |
| `GET /health` | none | Liveness check |
| `GET /ws` (WebSocket) | read | Live feed: `{ type: 'event' | 'status' | 'sync', … }` messages |

Changes to people, cards and permissions reach the controllers through the same automatic synchronisation used by the web interface.

## Examples

**Open the gate** (CasaAuto, a Home Assistant `rest_command`, a shortcut on the phone) — token with *Read + door opening* restricted to the gate:

```bash
curl -X POST -H "Authorization: Bearer uhd_…" http://192.168.1.10:8080/api/doors/1/open
# {"ok":true}
```

Home Assistant:

```yaml
rest_command:
  open_gate:
    url: http://192.168.1.10:8080/api/doors/1/open
    method: post
    headers:
      Authorization: !secret uhppote_gate_token   # "Bearer uhd_…"
```

**Today's denied accesses** (read-only token):

```bash
curl -H "Authorization: Bearer uhd_…" \
  "http://192.168.1.10:8080/api/events?from=$(date +%F)%2000:00:00&granted=false"
```

**Live feed** (Node.js, read-only token):

```js
import WebSocket from 'ws'
const ws = new WebSocket('ws://192.168.1.10:8080/api/ws', { headers: { Authorization: 'Bearer uhd_…' } })
ws.on('message', (data) => {
  const msg = JSON.parse(data)
  if (msg.type === 'event') console.log(msg.event.personName, msg.event.granted)
})
```

To be notified of events without keeping a connection open, use [outgoing webhooks](WEBHOOKS.md) or [MQTT](HOME-ASSISTANT.md).
