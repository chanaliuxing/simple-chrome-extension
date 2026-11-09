#!/usr/bin/env bash
# Install/refresh or uninstall the always-on receiver as a user LaunchAgent (macOS).
# Usage:
#   bash scripts/install-service.sh            # Install & start background service
#   bash scripts/install-service.sh --status   # Check status
#   bash scripts/install-service.sh --stop     # Stop & uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.gradevidence.browser-capture-receiver"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA="${BROWSER_CAPTURE_DATA:-$HOME/.gradevidence-browser-capture}"
LOGS="$HOME/Library/Logs/BrowserCapture"

action="${1:-install}"

case "$action" in
  --stop|--uninstall|stop|uninstall)
    echo "Stopping service $LABEL..."
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Service uninstalled."
    exit 0
    ;;
  --status|status)
    if [ -f "$PLIST" ]; then
      echo "Plist exists: $PLIST"
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state =|pid =|last exit' || echo "Service not currently running in launchd"
    else
      echo "Service is not installed."
    fi
    exit 0
    ;;
  install|--install|"")
    mkdir -p "$DATA" "$LOGS" "$HOME/Library/LaunchAgents"
    chmod 700 "$DATA"

    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$ROOT/server/collector.py</string>
    <string>--data-dir</string><string>$DATA</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/anaconda3/bin</string>
    <key>PYTHONPATH</key><string>$ROOT/server</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
    <key>DEVELOPER_DIR</key><string>/Library/Developer/CommandLineTools</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/receiver.log</string>
  <key>StandardErrorPath</key><string>$LOGS/receiver.error.log</string>
</dict>
</plist>
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    pkill -f 'server/collector.py.*serve' 2>/dev/null || true
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    sleep 1
    echo "Service: $LABEL"
    echo "Data:    $DATA"
    echo "Logs:    $LOGS/receiver.log"
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state =|pid =|last exit' || true
    ;;
  *)
    echo "Usage: $0 [install | --status | --stop]"
    exit 1
    ;;
esac
