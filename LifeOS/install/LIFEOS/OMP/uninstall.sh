#!/usr/bin/env bash
# One-shot uninstaller for the LifeOS<->OMP integration. Removes the extension
# wiring + constitution symlink from the OMP agent dir. Leaves the LIFEOS/OMP
# source tree and the additive tool patches (both harmless) in place.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$DIR/manage.ts" uninstall "$@"
