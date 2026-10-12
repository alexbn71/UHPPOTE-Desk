# Anomaly detection

*Operations → Anomalies* looks at the event history for three kinds of anomalies. The first two are also checked on every new event, so they can be [notified](NOTIFICATIONS.md) or sent to a [webhook](WEBHOOKS.md) as they happen, and they are part of the daily report.

## Unusual times

UHPPOTE Desk learns each person's habits from their granted accesses over the last **60 days** (*Days of history for the habits*). An access is unusual when:

| Why | Rule |
|---|---|
| **Outside the usual times** | It is more than **90 minutes** (*Tolerance*) from every time the person came in during the history. The list shows the person's usual window (from the 5th to the 95th percentile of their times), e.g. "08:02–08:28". |
| **Non-working day: never before** | It is on a Saturday, a Sunday or a holiday (*Attendance → Holidays*), and the person never came in on a non-working day during the history. |
| **Night access** | The person has fewer than **10** accesses of history (*Accesses needed to learn the habits*), so their habits are not known yet, and the access is in the night window (**22:00–06:00**). |

Only granted swipes of cards assigned to a person are analysed. In the page the habits are taken from the days *before* the selected period; for a new access, from the days before today.

The rule is about when someone usually comes in, so occasional overtime, an early shift or a weekend visit show up too. The list tells you what is unusual. Whether it is a problem is for you to judge.

## Repeated denied attempts

At least **3** denied swipes of the same card within **10 minutes** (*Denied attempts* / *within*). Swipes without a card number (e.g. a keypad) are grouped by door. Overlapping or close attempts form one entry, with the first and last time, the doors and the reasons.

This catches someone trying a card that was disabled or lost, a card used on a door it has no permission for, or someone testing cards at a reader. As a real-time event it is sent **once per burst**, when the threshold is reached.

## Inactive cards

Active cards without any granted access for at least **90 days** (*Card inactive after*). A card never used is counted from when it was created. Cards of people no longer active are marked.

Operators can select cards and **disable** them: they become *disabled* (as in *Cards*) and are removed from the controllers. Every disabled card is in the audit log (*disable-inactive-card*). A card can be enabled again from *Cards*.

## Settings

The thresholds are in the *Settings* tab: administrators can change them, everybody else can read them. They apply to the page, to the real-time events and to the daily report.

## Real-time events and daily report

| Event | Sent when |
|---|---|
| `anomaly.unusual_time` | A new granted access is unusual for the person |
| `anomaly.repeated_denied` | A new denied swipe reaches the threshold of repeated attempts |

Choose them in *Notifications* or *Webhooks*. In webhooks their `data` has the fields of the access event plus `kind`, `usualFrom`, `usualTo` and `samples` (unusual time), or `count` and `windowMinutes` (repeated attempts).

The daily report lists the unusual times and the repeated denied attempts of the last 24 hours among the anomalies.
