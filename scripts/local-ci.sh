#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

cd "$ROOT_DIR"

printf '%s\n' '==> Install locked dependencies'
npm ci

printf '%s\n' '==> Typecheck'
npm run check

printf '%s\n' '==> Check CLI E2E runtime'
command -v python3 >/dev/null 2>&1 || {
  printf '%s\n' 'Python 3 is required for the CLI interaction E2E test.' >&2
  exit 1
}

printf '%s\n' '==> Build, unit tests, and CLI interaction E2E'
npm test
