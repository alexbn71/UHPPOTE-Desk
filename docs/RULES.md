# Automation rules

*Administration → Rules* lets administrators define automations: **when** something happens, **only if** the conditions match, **then** run the actions. For example:

- "if card 10058400 is used after 22:00 → notify me on Telegram";
- "if a door stays open more than 2 minutes → alarm";
- "if the gate opens for a delivery outside working hours → call the n8n webhook";
- "if Mario badges at the garage → open the inner door too".

## When

| Trigger | Fires |
|---|---|
| Any event of the [webhook list](WEBHOOKS.md#events) | Access granted or denied, door event, alarm, door opened or closed (sensor), controller offline or back online, access at an unusual time, repeated denied attempts |
| **Door open longer than…** | When the door sensor still reports the door open after the given seconds (at least 10). Once per opening: the check starts when the door opens and is cancelled when it closes or when the controller goes offline. |

The door-open trigger needs the door sensor (door contact) wired to the controller. Without it, the controller never reports the door as open.

## Only if

All the conditions must match (empty = no restriction):

- **Doors**: only events of those doors (controller events: controllers that have one of them).
- **People** and **Cards**: only accesses of those people or card numbers; if both are filled, either one is enough.
- **From / To**: a time window, which may cross midnight (e.g. 22:00–06:00). The time is the controller time of the event.
- **Days**: days of the week.

## Then

- **Send a notification to**: one or more [notification channels](NOTIFICATIONS.md). The title is the rule name; the emoji and priority come from the severity (information ℹ️, warning ⚠️, alarm 🚨 with the highest priority). On Telegram, if the channel has the *Open door* button enabled, the message about a door carries the button.
- **Call the webhooks**: a `rule.triggered` request to the selected [webhooks](WEBHOOKS.md), with `data`: `ruleId`, `rule`, `severity`, `text`, `trigger`, `seconds` (door open for) and `event` (the data of the triggering event).
- **Open the doors**: opens the selected doors. The opening is in the audit log as `rule:<name>`. Events caused by that opening (the remote-open event, the door sensor) do not trigger rules on that door for 10 seconds, so two rules cannot keep opening doors in a loop.

Every firing is also shown to the people using the web app: alarms stay on screen until closed, other severities for 10 seconds. A rule without actions does only that.

## Message

Empty = an automatic text (for example "Access denied — Gate / unknown card 10058400 / 22:31:05 · No access rights", or "Gate open for 2 min"). Otherwise your text, with these placeholders:

| Placeholder | Value |
|---|---|
| `{person}` | Person (or "unknown card N") |
| `{card}` | Card number |
| `{door}` | Door name (controller name for controller events) |
| `{controller}` | Controller name |
| `{time}` / `{date}` | Time and date of the event |
| `{reason}` | Reason of the event (e.g. "No access rights") |
| `{duration}` | How long the door has been open (door-open trigger) |

The *Language of the texts* sets the language of the automatic text and of `{reason}`.

## Pause after firing

With a pause (seconds), the rule does not fire again until the pause has passed, e.g. 300 to get at most one message every 5 minutes from a busy door. The pause also survives a restart.

## History

The list shows when each rule last fired and how many times. *History* shows the last 200 firings with their text and the actions that could not run (a deleted channel, a door that could not be opened…).
