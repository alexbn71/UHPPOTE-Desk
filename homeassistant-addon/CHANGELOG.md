# Changelog

The full history of UHPPOTE Desk is in the
[project changelog](https://github.com/alexbn71/UHPPOTE-Desk/blob/main/CHANGELOG.md).

## 1.2.5

- A disabled controller is no longer queried when its page is opened (Diagnostics says it is disabled).
- *Silent reader on an invalid card*: verified on UHPPOTE firmware v9.f8; the hint explains the wiring.

## 1.2.4

- **Cards of every Wiegand format (26 to 40 bits)**: card numbers up to 4294967294 can be registered, also with one
  click from the cards read by a Wiegand-34 reader (before: Wiegand-26 only).
- Unknown cards always appear in "Capture from a reader" (they could be missing with some time zone settings).
- Dashboard: door names in the per-door chart on one line.

## 1.2.3

- **Events for the expansion board inputs A1–A3**: mark the inputs you use on the *Expansion board* tab; their
  openings and closings appear in the monitor and the event history and can trigger rules, notifications and
  webhooks (*Expansion input opened* / *closed again*).

## 1.2.2

- **Expansion board inputs A1–A3** as Home Assistant binary sensors *Expansion input A1–A3* (on = normally closed
  contact open), read every 2 s, and in the controller *Diagnostics*.
- Turning *Expansion board connected* on or off adds or removes its Home Assistant entities at once (before: only
  after restarting the add-on).
- Version shown in the footer of the web interface; user manual in Italian, German, French and Spanish.

## 1.2.1

- New option **Emergency access without two-factor authentication**: administrators log in with the password only
  and can switch off their own two-factor authentication (lost phone and recovery codes). Operators still need
  their code. Turn it off again right after.
- Italian: *Sincronizza orologio* instead of the ambiguous *Sincronizza ora*.

## 1.2.0

- **Two-factor authentication** for the operators (authenticator app), with recovery codes; administrators choose
  who must use it on the *Operators* page.
- **Expansion board UT0311-01A**: tested on hardware; new Home Assistant binary sensors *Expansion output 1–4*
  (controllers with *Expansion board connected*), followed live after alarms.
- **Fire alarm** sensor: on at once at the fire event and off a few seconds after the input is released (before:
  up to the next status check, or never for a short alarm).
- Licence plates (AgentDVR), guest links without card or app, persons inside, reader and door options.

## 1.1.0

- First version of the Home Assistant add-on (amd64 and aarch64): MQTT broker, network addresses and time zone
  configured automatically, database included in the Home Assistant backups.
