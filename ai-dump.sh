#!/usr/bin/env bash
set -euo pipefail

# Wrapper to match the usage/help text in AI-DUMP.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/AI-DUMP.sh" "$@"
