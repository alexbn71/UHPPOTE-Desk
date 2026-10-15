#!/usr/bin/env bash
# Release notes of a version, taken from CHANGELOG.md, with a "Docker image" section.
# Relative links become absolute, so they also work on the release page.
#   .github/scripts/release-notes.sh 1.0.0 [owner/repo] > notes.md
set -euo pipefail
version="$1"
repo="${2:-${GITHUB_REPOSITORY:-alexbn71/UHPPOTE-Desk}}"
owner="${repo%%/*}"

notes=$(awk -v v="$version" '
  $0 ~ "^## \\[" v "\\]" { on = 1; next }
  on && /^## \[/ { exit }
  on && !/^\[[^]]+\]: / { print }
' CHANGELOG.md)
if [ -z "$(echo "$notes" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md has no entry for $version" >&2
  exit 1
fi

echo "$notes" | perl -pe 's#\]\((?!https?://|\#)([^)\s]+)\)#](https://github.com/'"$repo"'/blob/main/$1)#g'
image="ghcr.io/${owner,,}/uhppote-desk"
printf '\n### Docker image\n\n```\ndocker pull %s:%s\n```\n\nAlso tagged `%s` and `%s` (latest release of the series).\n' \
  "$image" "$version" "${version%.*}" "${version%%.*}"
