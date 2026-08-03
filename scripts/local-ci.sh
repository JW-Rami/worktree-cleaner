#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

cd "$ROOT_DIR"

printf '%s\n' '==> Install locked dependencies'
npm ci

printf '%s\n' '==> Typecheck'
npm run check

printf '%s\n' '==> Build and test'
npm test
