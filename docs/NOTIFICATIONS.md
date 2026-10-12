# Notifications

UHPPOTE Desk can send messages on **Telegram**, by **email** (SMTP), and to **ntfy** or **Gotify**, two push servers you can run on your own NAS without any cloud service. On Telegram the messages can carry an **Open door** button, and every channel can receive a **daily report**.

Channels are managed by administrators in *Administration → Notifications*. Each channel has:

- the **events** that send a message (same list as the [webhooks](WEBHOOKS.md#events)): access granted or denied, door events, alarms, door opened or closed (sensor), controller offline or back online;
- an optional **door filter**;
- the **language** of the messages;
- the optional **daily report** and the hour to send it;
- the settings of the channel type, described below.

*Send test* sends a test message right away; *Send report now* sends the daily report. The list shows when the last message was sent and the last error, if any. Passwords and tokens are never shown again after saving: the form shows `••••••••`, and leaving it unchanged keeps the stored value.

Every event sends one message. "Access granted" can mean many messages a day: choose it only together with a door filter (e.g. the gate at home).

Events from the controller older than 10 minutes (downloaded when a controller comes back online) do not send messages. A message that cannot be sent is retried once after 5 seconds.

## Telegram

1. In Telegram, talk to **@BotFather**, send `/newbot` and follow the instructions. Copy the **token** it gives you (`123456789:AA…`).
2. Write `/id` to your new bot, or add the bot to a group and write `/id` in the group. The bot answers with the **chat ID** and **your user ID**. UHPPOTE Desk answers `/id` only after a channel with that bot is saved, so save it first with any chat ID and correct it afterwards.
3. Create the channel: bot token, chat ID (a negative number for groups, or `@channelname` for a public channel where the bot is an administrator).

UHPPOTE Desk receives the bot's updates by long polling: the server only needs outgoing internet access. No public address or open port is needed. The same bot cannot be used by another program at the same time (Telegram allows one reader of the updates).

### Open door button

With *"Open door" button* enabled, the messages about a door carry a **🔓 Open <door>** button. Pressing it opens that door.

- Only the Telegram users listed in *Telegram users allowed to open* can use it (numeric user IDs, from `/id`). Anyone else gets "You are not allowed…" and nothing happens.
- The button works for **15 minutes** after the message was sent, and only in the configured chat.
- The button data is signed: a modified Telegram client cannot turn it into a button for another door.
- With a door filter, only the doors of the filter can be opened.
- After the door opens, the bot writes in the chat who opened it. The opening is in the audit log as `telegram:<username>`, with the Telegram user ID.

## Daily report

At the chosen hour the channel receives a summary of the **last 24 hours**:

- **who came in**: every person with granted accesses, with the first and last time and the doors;
- **denied accesses**: time, door, person or card, reason;
- **alarms**: door open too long, forced door, fire, theft prevention, emergency…;
- **controllers offline** at that moment;
- or "Anomalies: none".

Long lists are cut after 25 lines. With a door filter, the report covers only those doors. The report is sent once a day: if the server is off at that hour, that day's report is skipped.

## Email (SMTP)

| Field | Example |
|---|---|
| SMTP server / port | `smtp.gmail.com` / `587` |
| TLS from the start | on for port 465; off for 587 or 25 (STARTTLS is used when the server offers it) |
| Username / password | the mailbox credentials; for Gmail and Microsoft 365 an **app password** |
| Sender | `UHPPOTE Desk <doors@example.com>` (many providers require the mailbox address) |
| Recipients | addresses separated by commas |

## ntfy

[ntfy](https://ntfy.sh) delivers push notifications to the ntfy app (Android, iOS, web). Run your own server on the NAS, e.g. with Docker:

```yaml
services:
  ntfy:
    image: binwiederhier/ntfy
    command: serve
    ports: ["8081:80"]
    volumes: ["./ntfy:/var/cache/ntfy"]
    restart: unless-stopped
```

Channel: server `http://192.168.1.10:8081`, topic e.g. `doors` (subscribe to the same topic in the app). If the topic is protected, set an access token (`tk_…`) or a username and password. Alarms are sent with priority 5 (urgent), denied accesses and controllers offline with 4.

## Gotify

[Gotify](https://gotify.net) is a self-hosted push server with an Android app. In Gotify, *Apps → Create application* and copy the application token. Channel: server URL (e.g. `http://192.168.1.10:8082`) and the token.

## Troubleshooting

| Symptom | Solution |
|---|---|
| Telegram: `Unauthorized` | Wrong bot token |
| Telegram: `chat not found` | Wrong chat ID, or nobody has written to the bot yet (Telegram bots cannot start a conversation): write `/start` to the bot first |
| Telegram: the bot does not answer `/id`, log `Telegram bot: Conflict` | Another program reads the updates of the same bot, or a webhook is set on it: use a dedicated bot |
| Telegram: the button answers "not allowed" | Your user ID is not in the list, or the message is from another chat |
| Email: `EAUTH` | Wrong credentials; use an app password where required |
| Email: `ESOCKET` / `ETIMEDOUT` | Wrong port or TLS setting, or the server blocks outgoing SMTP |
| ntfy / Gotify: `HTTP 401` / `403` | Missing or wrong token |
| No message for an event | Check the events and the door filter of the channel, and that the channel is active |
