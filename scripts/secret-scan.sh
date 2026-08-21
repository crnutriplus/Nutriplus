#!/usr/bin/env bash
set -euo pipefail

pattern='(-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----|(?:sk-proj-|sk-)[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|VAPID_PRIVATE_KEY\s*[:=]\s*[\x22\x27]?[A-Za-z0-9_-]{20,})'
tracked_matches="$(git grep -IlP "$pattern" -- ':!public/ocr/**' ':!vendor/**' || true)"
mapfile -d '' -t untracked_files < <(git ls-files --others --exclude-standard -z -- ':!public/ocr/**' ':!vendor/**')
untracked_matches=""
if (( ${#untracked_files[@]} )); then
  untracked_matches="$(rg -l -I --pcre2 "$pattern" -- "${untracked_files[@]}" || true)"
fi
matches="${tracked_matches}${tracked_matches:+$'\n'}${untracked_matches}"

if [[ -n "$matches" ]]; then
  echo "Potential secrets found in tracked files:"
  printf '%s\n' "$matches"
  exit 1
fi

echo "Secret scan passed: no credential patterns found in tracked or new source files."
