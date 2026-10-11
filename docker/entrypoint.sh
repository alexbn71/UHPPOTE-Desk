#!/bin/sh
# UHPPOTE Desk container entrypoint.
#
# Started as root (default): makes sure the data directory exists and belongs to PUID:PGID
# (default 1000:1000, the "node" user), then runs the application as that user.
# This makes host bind mounts (e.g. -v /srv/uhppote:/data) work out of the box.
#
# Started as a non-root user (docker run --user ...): runs the application directly; the data
# directory must then already be writable by that user (the application reports it clearly if not).
set -eu

DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # fix the ownership only when needed (avoids a slow recursive chown on every start)
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ] || [ -n "$(find "$DATA_DIR" -mindepth 1 \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit 2>/dev/null)" ]; then
    echo "entrypoint: setting the owner of $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi

exec "$@"
