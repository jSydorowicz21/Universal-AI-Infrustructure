#!/usr/bin/env bash
# One-shot installer for the LifeOS<->OMP integration. Wires the extensions
# into ~/.omp/agent/config.yml and symlinks the adapted constitution. Idempotent.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$DIR/manage.ts" install "$@"
