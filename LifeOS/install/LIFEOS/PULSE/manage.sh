#!/bin/bash
# LifeOS Pulse — Process Management
# Usage: manage.sh {start|stop|restart|status|install|uninstall}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALLED_LIFEOS_ROOT="$(dirname -- "$SCRIPT_DIR")"

if [ -n "${LIFEOS_DIR:-}" ]; then
  LIFEOS_ROOT="$LIFEOS_DIR"
  CONFIG_ROOT="${LIFEOS_CONFIG_ROOT:-${CLAUDE_CONFIG_DIR:-$(dirname -- "$LIFEOS_ROOT")}}"
elif [ -n "${LIFEOS_CONFIG_ROOT:-}" ]; then
  CONFIG_ROOT="$LIFEOS_CONFIG_ROOT"
  LIFEOS_ROOT="$CONFIG_ROOT/LIFEOS"
elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  CONFIG_ROOT="$CLAUDE_CONFIG_DIR"
  LIFEOS_ROOT="$CONFIG_ROOT/LIFEOS"
else
  LIFEOS_ROOT="$INSTALLED_LIFEOS_ROOT"
  CONFIG_ROOT="$(dirname -- "$LIFEOS_ROOT")"
fi
PULSE_DIR="$LIFEOS_ROOT/PULSE"
PLIST_NAME="com.lifeos.pulse"
PLIST_SRC="$PULSE_DIR/$PLIST_NAME.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
PID_FILE="$PULSE_DIR/state/pulse.pid"
STATE_FILE="$PULSE_DIR/state/state.json"

# Resolve bun's actual location for the launchd job. The public plist
# template ships with `__BUN_PATH__` so the job works for both brew users
# (/opt/homebrew/bin/bun) and curl-installer users (~/.bun/bin/bun).
#
# Order matters. `command -v bun` can resolve to a temporary helper shim
# inside `/private/tmp/bun-node-*/bun` when this script runs inside `bun
# install` (the child shell has its own PATH). That path is ephemeral and
# the launchd job would fail on next boot. Prefer the canonical install
# locations and fall back to `command -v bun` only if neither exists.
DISCOVERED_BUN="$(command -v bun 2>/dev/null || true)"
if [ -n "$DISCOVERED_BUN" ] && [ -x "$DISCOVERED_BUN" ] &&
   ! printf '%s' "$DISCOVERED_BUN" | grep -Eq '^(/private)?/tmp/'; then
  BUN_PATH="$DISCOVERED_BUN"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_PATH="$HOME/.bun/bin/bun"
elif [ -x "/opt/homebrew/bin/bun" ]; then
  BUN_PATH="/opt/homebrew/bin/bun"
elif [ -x "/usr/local/bin/bun" ]; then
  BUN_PATH="/usr/local/bin/bun"
elif [ -x "/usr/bin/bun" ]; then
  BUN_PATH="/usr/bin/bun"
else
  echo "ERROR: bun not found; install bun and re-run." >&2
  exit 1
fi

# OS detection — Linux uses systemd --user, macOS uses launchctl.
OS=$(uname -s)
SERVICE_SRC="$PULSE_DIR/$PLIST_NAME.service"
SYSTEMD_SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DST="$SYSTEMD_SERVICE_DIR/$PLIST_NAME.service"

materialize_service() {
  sed \
    -e "s|__HOME__/.claude/LIFEOS|$LIFEOS_ROOT|g" \
    -e "s|__HOME__/.claude|$CONFIG_ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__CONFIG_ROOT__|$CONFIG_ROOT|g" \
    -e "s|__LIFEOS_DIR__|$LIFEOS_ROOT|g" \
    -e "s|__BUN_PATH__|$BUN_PATH|g" \
    "$1" > "$2"
}

wait_for_pulse() {
  for _ in $(seq 1 60); do
    sleep 0.5
    if curl -fsS --max-time 1 -o /dev/null http://localhost:31337/healthz 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

case "$1" in
  start)
    if [ "$OS" = "Linux" ]; then
      if ! systemctl --user start "$PLIST_NAME"; then
        echo "ERROR: failed to start LifeOS Pulse with systemd." >&2
        exit 1
      fi
      echo "LifeOS Pulse started"
    else
      if [ ! -f "$PLIST_DST" ]; then
        # Substitute __HOME__ + __BUN_PATH__ placeholders (public template);
        # no-op on plists that already have literal paths.
        materialize_service "$PLIST_SRC" "$PLIST_DST"
      fi
      if launchctl list "$PLIST_NAME" >/dev/null 2>&1; then
        echo "LifeOS Pulse already started"
      elif launchctl load "$PLIST_DST"; then
        echo "LifeOS Pulse started"
      else
        echo "ERROR: failed to load LifeOS Pulse launch agent at $PLIST_DST." >&2
        exit 1
      fi
    fi
    ;;

  stop)
    if [ "$OS" = "Linux" ]; then
      systemctl --user stop "$PLIST_NAME" 2>/dev/null
    else
      launchctl unload "$PLIST_DST" 2>/dev/null
    fi
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      kill "$PID" 2>/dev/null
      echo "LifeOS Pulse stopped (PID $PID)"
    else
      echo "LifeOS Pulse stopped"
    fi
    ;;

  restart)
    # Use the resolved script path, not bare "$0" — when invoked as `bash manage.sh
    # restart` (no leading path) "$0" is just `manage.sh` and the self-reinvoke fails
    # with "command not found".
    bash "$PULSE_DIR/manage.sh" stop
    sleep 2
    bash "$PULSE_DIR/manage.sh" start
    ;;

  status)
    if [ "$OS" = "Linux" ]; then
      systemctl --user status "$PLIST_NAME"
    else
      if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
          UPTIME=$(ps -p "$PID" -o etime= | xargs)
          echo "LifeOS Pulse: RUNNING (PID $PID, uptime $UPTIME)"
        else
          echo "LifeOS Pulse: DEAD (stale PID $PID)"
        fi
      else
        echo "LifeOS Pulse: NOT RUNNING (no PID file)"
      fi
    fi

    if [ -f "$STATE_FILE" ]; then
      echo ""
      echo "Last job runs:"
      "$BUN_PATH" -e "
        const state = JSON.parse(require('fs').readFileSync('$STATE_FILE', 'utf-8'));
        for (const [name, info] of Object.entries(state.jobs)) {
          const ago = Math.round((Date.now() - info.lastRun) / 60000);
          const status = info.consecutiveFailures > 0 ? ' [FAILING x' + info.consecutiveFailures + ']' : '';
          console.log('  ' + name + ': ' + ago + ' min ago (' + info.lastResult + ')' + status);
        }
      " 2>/dev/null
    fi
    ;;

  install)
    mkdir -p "$PULSE_DIR/state" "$PULSE_DIR/logs"
    if ! (cd "$PULSE_DIR" && "$BUN_PATH" install --frozen-lockfile); then
      echo "ERROR: failed to install Pulse runtime dependencies." >&2
      exit 1
    fi
    if [ -f "$PULSE_DIR/Observability/package.json" ]; then
      if ! (cd "$PULSE_DIR/Observability" &&
            "$BUN_PATH" install --frozen-lockfile &&
            "$BUN_PATH" run build); then
        echo "ERROR: failed to install/build Pulse Observability." >&2
        exit 1
      fi
    fi

    if [ "$OS" = "Linux" ]; then
      mkdir -p "$SYSTEMD_SERVICE_DIR"
      # Kill any prior pulse before installing fresh — prevents the stale-PID
      # / unbound-port half-dead state where a previous service-managed pulse
      # is alive with open fds but never bound :31337.
      systemctl --user stop "$PLIST_NAME" 2>/dev/null || true
      pkill -9 -f "bun.*pulse.ts" 2>/dev/null || true
      sleep 1
      # Substitute __HOME__ + __BUN_PATH__ placeholders (public template);
      # no-op on service files that already have literal paths.
      materialize_service "$SERVICE_SRC" "$SERVICE_DST"
      # Ensure user services survive logout/reboot (no-op if already enabled)
      loginctl enable-linger "$USER" 2>/dev/null || true
      systemctl --user daemon-reload
      systemctl --user enable "$PLIST_NAME"
      systemctl --user start "$PLIST_NAME"
    else
      # Cleanup any prior pulse before installing fresh — prevents the stale-PID
      # / unbound-port half-dead state where a previous launchd-managed pulse is
      # alive with open fds but never bound :31337.
      if [ -f "$PLIST_DST" ]; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
      fi
      pkill -9 -f "bun.*pulse.ts" 2>/dev/null || true
      sleep 1

      # Substitute __HOME__ + __BUN_PATH__ placeholders (public template);
      # no-op on plists that already have literal paths.
      materialize_service "$PLIST_SRC" "$PLIST_DST"
      launchctl load "$PLIST_DST"
    fi

    # Verify the service. A slow first boot gets one explicit restart and retry.
    if wait_for_pulse; then
      echo "LifeOS Pulse installed and verified on port 31337 (bun: $BUN_PATH)"
      exit 0
    fi

    echo "Pulse did not bind on the first attempt; restarting once before failing." >&2
    if [ "$OS" = "Linux" ]; then
      systemctl --user restart "$PLIST_NAME" 2>/dev/null || true
    else
      launchctl kickstart -k "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
    fi
    if wait_for_pulse; then
      echo "LifeOS Pulse installed and verified after one restart (bun: $BUN_PATH)"
      exit 0
    fi

    echo "ERROR: LifeOS Pulse installed but port 31337 did not bind after two 30s attempts." >&2
    echo "  Check: tail -50 $PULSE_DIR/logs/pulse-stderr.log" >&2
    exit 1
    ;;

  uninstall)
    if [ "$OS" = "Linux" ]; then
      systemctl --user disable --now "$PLIST_NAME" 2>/dev/null
      rm -f "$SERVICE_DST"
    else
      launchctl unload "$PLIST_DST" 2>/dev/null
      rm -f "$PLIST_DST"
    fi
    echo "LifeOS Pulse uninstalled"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|install|uninstall}"
    exit 1
    ;;
esac
