#!/usr/bin/env bash
# ai-dump.sh — Combine project text files into combined.txt with per-file headers
# Includes extra Bluesky controllers outside the project tree.

set -euo pipefail

# Move into the script’s directory
cd "$(dirname "$0")"

OUTFILE="combined.txt"
: > "$OUTFILE"   # truncate/create

# External sources
BSPHP="/var/www/concrete/theblobinc/live/packages/concretesky/controllers/single_page/concretesky.php"
BSDIR="/var/www/concrete/theblobinc/live/packages/concretesky/controllers/single_page/concretesky"

lang_from_ext() {
  case "${1##*.}" in
    php)  printf "php" ;;
    css)  printf "css" ;;
    html|htm) printf "html" ;;
    js|mjs|cjs) printf "javascript" ;;
    *)    printf "" ;;
  esac
}

emit_file() {
  local path="$1"
  [ -f "$path" ] || return 0

  # Absolute path if possible
  local abspath
  if abspath="$(readlink -f -- "$path" 2>/dev/null)"; then :; else abspath="$path"; fi

  local lang
  lang="$(lang_from_ext "$path")"

  {
    printf '===== BEGIN FILE: %s =====\n' "$abspath"
    if [ -n "$lang" ]; then
      printf '```%s\n' "$lang"
    else
      printf '```\n'
    fi
    cat -- "$path"
    printf '\n```\n'
    printf '===== END FILE: %s =====\n\n' "$abspath"
  } >> "$OUTFILE"
}

# Build a sorted list of project files
project_list="$(mktemp)"
trap 'rm -f "$project_list"' EXIT

find . -type f \
  \( -name "*.php" -o -name "*.css" -o -name "*.html" -o -name "*.js" \) \
  -not -path "./dist/*" \
  -not -path "./sounds/*" \
  -not -path "./img/*" \
  -not -path "./js/old/*" \
  -not -name "combined.txt" \
  -print0 \
| tr '\0' '\n' \
| LC_ALL=C sort > "$project_list"

# Emit project files
while IFS= read -r path; do
  [ -n "$path" ] || continue
  emit_file "$path"
done < "$project_list"

# Append external single file
[ -f "$BSPHP" ] && emit_file "$BSPHP"

# Append external directory files (sorted)
if [ -d "$BSDIR" ]; then
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    emit_file "$path"
  done < <(find "$BSDIR" -type f \
            \( -name "*.php" -o -name "*.css" -o -name "*.html" -o -name "*.js" \) \
            -print0 | tr '\0' '\n' | LC_ALL=C sort)
fi

printf 'combined.txt has been regenerated with per-file headers and Bluesky sources.\n'
