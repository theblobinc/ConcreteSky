#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="$ROOT_DIR"

TZ_PACIFIC="America/Los_Angeles"

usage() {
  cat <<'USAGE'
Usage:
  ./ai-dump.sh
  ./ai-dump.sh --install-hook

Creates a timestamped AI dump containing:
  - A tree of all included source files
  - Full contents of each included file

Selection rules:
  - Includes tracked files and untracked-but-not-ignored files
  - Excludes anything gitignored (via git --exclude-standard)
  - Excludes any directory named "dist" or "_private" at any depth
  - Tree includes code + TODO markdown + images
  - Dump includes code + TODO markdown only (no images/binaries/db files)

Output:
  - Writes to _private/dumps/ai-dump_<YYYY-MM-DD_HH-MM-SS_TZ>.txt
  - Also updates _private/dumps/ai-dump_latest.txt
USAGE
}

install_hook() {
  if ! command -v git >/dev/null 2>&1 || ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: git repo not detected at $ROOT_DIR" >&2
    exit 1
  fi

  mkdir -p "$ROOT_DIR/.githooks"
  cat >"$ROOT_DIR/.githooks/pre-commit" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT_DIR/ai-dump.sh" >/dev/null 2>&1
HOOK
  chmod +x "$ROOT_DIR/.githooks/pre-commit"

  git -C "$ROOT_DIR" config core.hooksPath .githooks
  echo "Installed pre-commit hook at $ROOT_DIR/.githooks/pre-commit"
  echo "Enabled via: git config core.hooksPath .githooks"
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --install-hook)
    install_hook
    exit 0
    ;;
esac

if [[ $# -gt 0 ]]; then
  echo "NOTE: ai-dump.sh ignores arguments and always scans its own folder: $ROOT_DIR" >&2
fi

STAMP_HUMAN="$(TZ="$TZ_PACIFIC" date '+%Y-%m-%d %I:%M:%S %p %Z')"
STAMP_FILE="$(TZ="$TZ_PACIFIC" date '+%Y-%m-%d_%I-%M-%S_%p_%Z')"

OUT_DIR="$ROOT_DIR/_private/dumps"
mkdir -p "$OUT_DIR"

OUT_FILE="$OUT_DIR/ai-dump_${STAMP_FILE}.txt"
LATEST_FILE="$OUT_DIR/ai-dump_latest.txt"

collect_files() {
  local root="$1"

  # Produce an initial candidate set of paths (NUL-delimited, repo-relative).
  if command -v git >/dev/null 2>&1 && git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Includes tracked + untracked (but not ignored) files.
    git -C "$root" ls-files -z --cached --others --exclude-standard
    return
  fi

  # Fallback if not a git repo: best-effort search.
  (cd "$root" && find . \
    \( -type d \( -name 'dist' -o -name '_private' -o -name '.git' \) -prune \) -o \
    -type f -print0
  )
}

collect_files_tree() {
  local root="$1"

  local py
  py=$'import os\nimport sys\n\nEXCLUDE_DIRS = {"dist", "_private", ".git", "node_modules", "vendor"}\n\nCODE_EXTS = {\n    ".php", ".py", ".js", ".ts", ".jsx", ".tsx",\n    ".css", ".less", ".scss", ".sass",\n    ".html", ".htm",\n    ".json", ".yml", ".yaml",\n    ".xml", ".toml", ".ini",\n    ".sh",\n}\n\nIMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"}\n\nraw = sys.stdin.buffer.read().split(b"\\0")\nout = []\n\nfor p in raw:\n    if not p:\n        continue\n    s = p.decode("utf-8", errors="replace")\n    s = s[2:] if s.startswith("./") else s\n    if not s:\n        continue\n    parts = [x for x in s.split("/") if x]\n    if any(x in EXCLUDE_DIRS for x in parts):\n        continue\n\n    base = os.path.basename(s).lower()\n    ext = os.path.splitext(base)[1]\n\n    is_todo_md = base.endswith(".md") and ("todo" in base)\n    if ext in CODE_EXTS or ext in IMAGE_EXTS or is_todo_md:\n        out.append(s)\n\nout.sort()\nfor s in out:\n    sys.stdout.buffer.write(s.encode("utf-8", errors="replace") + b"\\0")\n'

  collect_files "$root" | python3 -c "$py"
}

collect_files_dump() {
  local root="$1"

  local py
  py=$'import os\nimport sys\n\nEXCLUDE_DIRS = {"dist", "_private", ".git", "node_modules", "vendor"}\n\n# Only dump text-ish sources. Images are shown in the tree but not dumped.\nTEXT_EXTS = {\n    ".php", ".py", ".js", ".ts", ".jsx", ".tsx",\n    ".css", ".less", ".scss", ".sass",\n    ".html", ".htm",\n    ".json", ".yml", ".yaml",\n    ".xml", ".toml", ".ini",\n    ".sh",\n    ".sql",\n    ".txt",\n}\n\n# Explicitly skip common DB/binary container extensions.\nSKIP_EXTS = {\n    ".db", ".sqlite", ".sqlite3", ".mdb", ".accdb",\n    ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",\n    ".pdf", ".mp3", ".mp4", ".mov", ".avi", ".mkv",\n    ".exe", ".dll", ".so", ".dylib",\n}\n\nraw = sys.stdin.buffer.read().split(b"\\0")\nout = []\n\nfor p in raw:\n    if not p:\n        continue\n    s = p.decode("utf-8", errors="replace")\n    s = s[2:] if s.startswith("./") else s\n    if not s:\n        continue\n    parts = [x for x in s.split("/") if x]\n    if any(x in EXCLUDE_DIRS for x in parts):\n        continue\n\n    base = os.path.basename(s).lower()\n    ext = os.path.splitext(base)[1]\n    if ext in SKIP_EXTS:\n        continue\n\n    is_todo_md = base.endswith(".md") and ("todo" in base)\n    if ext in TEXT_EXTS or is_todo_md:\n        out.append(s)\n\nout.sort()\nfor s in out:\n    sys.stdout.buffer.write(s.encode("utf-8", errors="replace") + b"\\0")\n'

  collect_files "$root" | python3 -c "$py"
}

render_tree() {
  # Reads NUL-delimited relative paths on stdin and prints a compact ASCII tree.
  python3 -c $'import sys\n\ndata = sys.stdin.buffer.read().split(b"\\0")\npaths = [p.decode("utf-8", errors="replace") for p in data if p]\npaths = [p[2:] if p.startswith("./") else p for p in paths]\npaths = [p for p in paths if p]\npaths.sort()\n\ntree = {}\nfor p in paths:\n    cur = tree\n    parts = p.split("/")\n    for part in parts:\n        cur = cur.setdefault(part, {})\n\ndef walk(node, prefix=""):\n    keys = sorted(node.keys())\n    for idx, key in enumerate(keys):\n        last = idx == len(keys) - 1\n        branch = "└── " if last else "├── "\n        print(prefix + branch + key)\n        child = node[key]\n        if child:\n            ext = "    " if last else "│   "\n            walk(child, prefix + ext)\n\nprint(".")\nwalk(tree)\n'
}

{
  echo "AI DUMP"
  echo "Timestamp: $STAMP_HUMAN"
  echo "Root: $TARGET_ROOT"
  echo "Generated by: $ROOT_DIR/ai-dump.sh"
  echo

  echo "==== FILE TREE ===="
  # Tree of INCLUDED files only (excludes gitignored, dist/, _private/).
  # Includes images in the tree, but they are not dumped below.
  collect_files_tree "$TARGET_ROOT" | render_tree || true
  echo

  echo "==== FILE CONTENTS ===="
  while IFS= read -r -d '' rel; do
    [[ -z "$rel" ]] && continue
    rel="${rel#./}"
    abs="$TARGET_ROOT/$rel"

    [[ -f "$abs" ]] || continue

    # Safety: skip very large files (>2MB).
    size=$(stat -c %s "$abs" 2>/dev/null || echo 0)
    if [[ "$size" -gt $((2 * 1024 * 1024)) ]]; then
      echo "----- FILE: $rel (skipped: ${size} bytes) -----"
      echo
      continue
    fi

    # Skip binary files (shouldn't happen for .php/.py but keep it safe).
    if ! grep -Iq . "$abs"; then
      echo "----- FILE: $rel (skipped: binary) -----"
      echo
      continue
    fi

    echo "----- FILE: $rel -----"
    echo "PATH: $abs"
    echo
    cat "$abs"
    echo
  done < <(collect_files_dump "$TARGET_ROOT")
} >"$OUT_FILE"

# Update the stable "combined.txt" pointer.
cp -f "$OUT_FILE" "$LATEST_FILE"

echo "Wrote: $OUT_FILE"
echo "Latest: $LATEST_FILE"
