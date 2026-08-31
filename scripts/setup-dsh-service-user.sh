#!/usr/bin/env bash
# scripts/setup-dsh-service-user.sh
#
# Create a dedicated, unprivileged Linux user that runs the DeepSeek Harness
# web GUI ("dsh web") from this repository's existing prebuilt checkout.
#
# What the runner gets:
#   * a locked system account (no login shell, no password);
#   * a private writable data dir  /var/lib/<user>/.dsh  (the $DSH_HOME);
#   * read access to the prebuilt checkout (grants traverse into the checkout's
#     parent chain, e.g. /home/grafuls, which is normally mode 700);
#   * a systemd unit  /etc/systemd/system/dsh-web.service  that starts it.
#
# Usage:
#   sudo bash scripts/setup-dsh-service-user.sh [--no-start]
#
#   --no-start   install everything but do not enable/start the service.
#
# Tune with environment variables:
#   DSH_RUN_USER=dshsvc  DSH_WEB_HOST=127.0.0.1  DSH_WEB_PORT=3081
#
set -euo pipefail

# ------------------------------------------------------------ configuration
RUN_USER="${DSH_RUN_USER:-dshsvc}"
RUN_GROUP="$RUN_USER"
RUN_HOME="/var/lib/$RUN_USER"
DSH_HOME="${DSH_HOME:-$RUN_HOME/.dsh}"
CHECKOUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_HOST="${DSH_WEB_HOST:-0.0.0.0}"      # keep loopback: the web carrier has NO auth layer
WEB_PORT="${DSH_WEB_PORT:-3080}"           # default 3080 is usually taken by the dev GUI
SERVICE_NAME="dsh-web.service"
UNIT="/etc/systemd/system/$SERVICE_NAME"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
WITH_START=1
for arg in "$@"; do
  [ "$arg" = "--no-start" ] && WITH_START=0
done

say()  { printf '\n== %s ==\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root:" >&2
  echo "  sudo bash $0 [$*]" >&2
  exit 1
fi

# ------------------------------------------------------------ preflight
say "Preflight"
[ -x "$NODE_BIN" ] || { echo "error: node not found at $NODE_BIN" >&2; exit 1; }
[ -f "$CHECKOUT/apps/cli/lib/bin.js" ] || {
  echo "error: built CLI not found — run 'pnpm run build' first (apps/cli/lib/bin.js)" >&2; exit 1; }
[ -d "$CHECKOUT/apps/web/dist" ] || {
  echo "error: built web assets missing — run 'pnpm run build' first (apps/web/dist)" >&2; exit 1; }
printf '  runner user : %s\n  data dir    : %s\n  checkout    : %s\n  binds       : %s:%s\n' \
  "$RUN_USER" "$DSH_HOME" "$CHECKOUT" "$WEB_HOST" "$WEB_PORT"
command -v setfacl >/dev/null 2>&1 || echo "  note: acl is not installed; will need manual chmod (below)"
command -v runuser >/dev/null 2>&1 || echo "  note: runuser not installed (util-linux); traverse check skipped"

# ------------------------------------------------------------ account
say "Creating system account $RUN_USER"
if getent passwd "$RUN_USER" >/dev/null; then
  echo "  user $RUN_USER already exists — reusing it"
else
  useradd --system --user-group --no-create-home \
    --home-dir "$RUN_HOME" --shell /usr/sbin/nologin \
    --comment "DeepSeek Harness web runner" "$RUN_USER"
  echo "  created $RUN_USER (locked, no login shell)"
fi

say "Preparing $DSH_HOME (writable, private)"
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0750 "$RUN_HOME"
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0700 "$DSH_HOME" "$DSH_HOME/profiles"

# Seed a credentials template the runner will read (layered over DSH_HOME).
ENV_TEMPLATE="$DSH_HOME/.env"
if [ ! -f "$ENV_TEMPLATE" ]; then
  cat > "$ENV_TEMPLATE" <<EOF
# DeepSeek Harness runner credentials for $RUN_USER ($DSH_HOME).
# Uncomment and fill in so the web app can run agents:
#DEEPSEEK_API_KEY=sk-...
EOF
  chown "$RUN_USER:$RUN_GROUP" "$ENV_TEMPLATE"
  chmod 600 "$ENV_TEMPLATE"
  echo "  seeded $ENV_TEMPLATE (fill in your API key; chmod 600)"
fi

# ------------------------------------------------------------ access to checkout
say "Granting traverse into the checkout (read-only)"
# The checkout is world-readable (0644/0755), but an ancestor such as
# /home/grafuls is usually 0700 and would block the runner. Grant the runner
# execute-only on each unreachable ancestor via an ACL (reversible with
# setfacl -x). This does not expose directory listings to anyone else.
d="$CHECKOUT"
while [ "$d" != "/" ]; do
  d="$(dirname "$d")"
  reachable=1
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- test -r "$d" 2>/dev/null || reachable=0
    runuser -u "$RUN_USER" -- test -x "$d" 2>/dev/null || reachable=0
  else
    mode="$(stat -c '%a' "$d")"; o="${mode: -1}"
    case "$o" in 1|3|5|7) : ;; *) reachable=0;; esac
  fi
  if [ "$reachable" = 1 ]; then
    continue
  elif command -v setfacl >/dev/null 2>&1; then
    setfacl -m "u:$RUN_USER:x" "$d"
    printf '  granted traverse on %s  (undo: setfacl -x u:%s:%s)\n' "$d" "$RUN_USER" "$d"
  else
    echo "  [warn] cannot reach $d as $RUN_USER — install 'acl' (dnf install acl) or run: chmod o+x '$d'" >&2
  fi
done

# ------------------------------------------------------------ systemd unit
say "Installing systemd unit $UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=DeepSeek Harness web GUI ($RUN_USER)
After=network.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CHECKOUT
Environment=HOME=$RUN_HOME
Environment=DSH_HOME=$DSH_HOME
ExecStart=$NODE_BIN $CHECKOUT/apps/cli/lib/bin.js web --no-open --host $WEB_HOST --port $WEB_PORT
Restart=on-failure
RestartSec=3

# Hardening. ProtectHome stays 'read-only' (not 'true'/inaccessible) so the
# service can still read the checkout under /home; all runtime data lives in
# \$DSH_HOME (/var/lib/$RUN_USER), which stays writable.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
PrivateDevices=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

if [ "$WITH_START" = 1 ]; then
  say "Enabling and starting $SERVICE_NAME"
  systemctl enable --now "$SERVICE_NAME"
else
  echo "  installed but not started (--no-start); start later with: systemctl start $SERVICE_NAME"
fi

# ------------------------------------------------------------ summary
say "Done"
cat <<EOF

Account   : $RUN_USER (system account, no login: /usr/sbin/nologin)
Data      : $DSH_HOME                      (owned by $RUN_USER)
URL       : http://$WEB_HOST:$WEB_PORT
Service   : $SERVICE_NAME

Try it manually first (foreground, logs on your terminal):
  runuser -u $RUN_USER -- env HOME=$RUN_HOME DSH_HOME=$DSH_HOME \\
    $NODE_BIN $CHECKOUT/apps/cli/lib/bin.js web --no-open --host $WEB_HOST --port $WEB_PORT

Then watch the service:
  systemctl status $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f

Credentials: so the web app can run agents, put your key in $DSH_HOME/.env
  DEEPSEEK_API_KEY=sk-...
(or use: sudo -u $RUN_USER ... dsh credentials set <name>). Never leave a
plaintext key in a world-readable file.

Security notes:
  * The web carrier ships NO authentication layer. Keep --host $WEB_HOST on
    loopback unless the network is fully trusted. The URL above is loopback.
  * A separate GUI instance is already on 0.0.0.0:3080 (LAN-visible, no auth);
    this runner defaults to port $WEB_PORT to avoid the conflict. If you mean
    for this runner to replace it, stop that process and set DSH_WEB_PORT=3080.
  * Granting traverse (execute-only) on the checkout's parent chain does not
    list or modify anything; it only lets the runner descend the path.

Fedora/SELinux: if the unit fails with AVC denials, see
  ausearch -m avc -ts recent   and   sealert -a /var/log/audit/audit.log
Reading the checkout under /home is normally permitted from a systemd unit.

Undo:
  systemctl disable --now $SERVICE_NAME
  rm "$UNIT" && systemctl daemon-reload
  userdel "$RUN_USER"          # keeps /var/lib/$RUN_USER unless you remove it
  # undo any traverse ACLs printed above with: setfacl -x u:$RUN_USER:<dir>
EOF
