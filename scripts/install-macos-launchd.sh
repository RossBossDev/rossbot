#!/usr/bin/env bash
set -euo pipefail

APP_NAME="rossbot"
LABEL="${ROSSBOT_LAUNCHD_LABEL:-dev.rossboss.rossbot}"
INSTALL_DIR="${ROSSBOT_INSTALL_DIR:-$HOME/.rossbot/app}"
CONFIG_PATH="${ROSSBOT_CONFIG_PATH:-$HOME/.rossbot/config.json}"
ENV_PATH="${ROSSBOT_ENV_PATH:-$HOME/.rossbot/env}"
LOG_DIR="${ROSSBOT_LOG_DIR:-$HOME/.rossbot/logs}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
RUN_SCRIPT="$INSTALL_DIR/bin/run-$APP_NAME.sh"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer currently supports macOS launchd only." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || true
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required on the runner machine." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$(dirname "$PLIST_PATH")"

rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".DS_Store" \
  "$SOURCE_DIR/" "$INSTALL_DIR/"

cd "$INSTALL_DIR"
pnpm install --frozen-lockfile
pnpm build
mkdir -p "$(dirname "$RUN_SCRIPT")"

cat > "$RUN_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ -f "$ENV_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_PATH"
  set +a
fi

cd "$INSTALL_DIR"
exec node "$INSTALL_DIR/dist/cli.js" start --config "$CONFIG_PATH"
EOF
chmod +x "$RUN_SCRIPT"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUN_SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "$APP_NAME installed to $INSTALL_DIR and loaded as $LABEL"
echo "Config: $CONFIG_PATH"
echo "Env: $ENV_PATH"
echo "Logs: $LOG_DIR"
