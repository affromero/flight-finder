#!/usr/bin/env bash
# Prevent broad source folders from growing. Existing large folders are
# grandfathered for edits, but adding a source file above the cap fails.

set -euo pipefail

max_files="${FLIGHT_FINDER_MAX_FILES_PER_DIR:-10}"

is_source_file() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.rs|*.swift|*.py|*.sh) return 0 ;;
    *) return 1 ;;
  esac
}

is_added_or_untracked() {
  git diff --cached --name-only --diff-filter=A -- "$1" | grep -qxF "$1" && return 0
  git ls-files --others --exclude-standard -- "$1" | grep -qxF "$1"
}

count_dir_sources() {
  local dir="$1"
  git ls-files --cached --others --exclude-standard -- "$dir" | while IFS= read -r tracked; do
    [[ "$(dirname "$tracked")" == "$dir" ]] || continue
    is_source_file "$tracked" || continue
    printf '%s\n' "$tracked"
  done | wc -l | tr -d ' '
}

violations=""
seen_dirs=""

for file in "$@"; do
  [[ -f "$file" ]] || continue
  is_source_file "$file" || continue
  is_added_or_untracked "$file" || continue

  dir=$(dirname "$file")
  case "
$seen_dirs
" in
    *"
$dir
"*) continue ;;
  esac
  seen_dirs="${seen_dirs}${dir}
"

  count=$(count_dir_sources "$dir")
  if (( count > max_files )); then
    violations="${violations}${dir}: ${count} files
"
  fi
done

if [[ -n "$violations" ]]; then
  {
    echo "Source directories may contain at most ${max_files} files."
    echo "Add new files to a focused subdirectory instead:"
    printf '%s' "$violations" | sort
  } >&2
  exit 1
fi
