#!/usr/bin/env bash
# scripts/setup-dsh-service-user.sh
#
# Create a dedicated, unprivileged Linux user that runs the DeepSeek Harness
# web GUI from this repository's existing prebuilt checkout, matching the
# invocation:
#
#   pnpm dsh --profile web-collab --host 0.0.0.0 --trusted-host "$(hostname)" --no-open
#
# The unit runs the built-CLI equivalent of that line (the production runner,
# per apps/cli/reference/README.md), because pnpm itself lives under the
# owner's 0700 home directory and is not reachable by the service user:
#
#   node apps/cli/lib/bin.js --profile web-collab --host 0.0.0.0 \
#       --trusted-host <hostname> --no-open
#
# What the runner gets:
#   * a locked system account (no login shell, no password);
#   * a private writable data dir  /var/lib/<user>/.dsh  (the $DSH_HOME; the
#     collab bundle keeps its registries under <dshHome>/collab);
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
#   DSH_RUN_USER=dshsvc  DSH_WEB_PROFILE=web-collab  DSH_WEB_HOST=0.0.0.0
#   DSH_TRUSTED_HOST=<name>   DSH_WEB_PORT=<port only if you override the default>
#
set -euo pipefail

# ------------------------------------------------------------ configuration
RUN_USER="${DSH_RUN_USER:-dshsvc}"
RUN_GROUP="$RUN_USER"
RUN_HOME="/var/lib/$RUN_USER"
DSH_HOME="${DSH_HOME:-$RUN_HOME/.dsh}"
CHECKOUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PROFILE="${DSH_WEB_PROFILE:-web-collab}"
WEB_HOST="${DSH_WEB_HOST:-0.0.0.0}"               # all interfaces — matches `--host 0.0.0.0`
TRUSTED_HOST="${DSH_TRUSTED_HOST:-$(hostname)}"   # matches `--trusted-host $(hostname)`
WEB_PORT_OVERRIDE="${DSH_WEB_PORT:-}"             # empty => omit --port (web-app default: 3080)
SERVICE_NAME="dsh-web.service"
UNIT="/etc/systemd/system/$SERVICE_NAME"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
WITH_START=1
for arg in "$@"; do
  [ "$arg" = "--no-start" ] && WITH_START=0
done

WEB_ARGS=(--profile "$WEB_PROFILE" --host "$WEB_HOST" --trusted-host "$TRUSTED_HOST" --no-open)
if [ -n "$WEB_PORT_OVERRIDE" ]; then
  WEB_ARGS+=(--port "$WEB_PORT_OVERRIDE")
fi

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
[ -f "$CHECKOUT/packages/bundle/collab/lib/index.js" ] || {
  echo "error: built collab bundle missing — run 'pnpm run build' first (packages/bundle/collab/lib)" >&2; exit 1; }
printf '  runner user : %s\n  data dir    : %s\n  checkout    : %s\n  profile     : %s\n  binds       : %s%s\n  trusted-host: %s\n' \
  "$RUN_USER" "$DSH_HOME" "$CHECKOUT" "$WEB_PROFILE" "$WEB_HOST" \
  "${WEB_PORT_OVERRIDE:+:$WEB_PORT_OVERRIDE}" "$TRUSTED_HOST"
command -v setfacl >/dev/null 2>&1 || echo "  note: acl is not installed; will need manual chmod (below)"
command -v runuser >/dev/null 2>&1 || echo "  note: runuser not installed (util-linux); traverse check skipped"

if [ -z "$WEB_PORT_OVERRIDE" ] && ss -ltn 2>/dev/null | grep -q ":3080 "; then
  echo "  warning: port 3080 is already in use; the collab profile defaults to it."
  echo "           stop that instance first, or run with DSH_WEB_PORT=<other>."
fi

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
# Uncomment and fill in so agents can call the DeepSeek API:
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
Description=DeepSeek Harness web GUI ($WEB_PROFILE, $RUN_USER)
After=network.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CHECKOUT
Environment=HOME=$RUN_HOME
Environment=DSH_HOME=$DSH_HOME
ExecStart=$NODE_BIN $CHECKOUT/apps/cli/lib/bin.js ${WEB_ARGS[*]}
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
  systemctl enable "$SERVICE_NAME"
  systemctl start "$SERVICE_NAME" || {
    echo "  warning: start failed — check 'journalctl -u $SERVICE_NAME -e'" >&2
    echo "           (most likely the port is already taken, or an SELinux denial)." >&2
  }
else
  echo "  installed but not started (--no-start); start later with: systemctl start $SERVICE_NAME"
fi

# ------------------------------------------------------------ summary
say "Done"
cat <<EOF

Account    : $RUN_USER (system account, no login: /usr/sbin/nologin)
Data       : $DSH_HOME                         (owned by $RUN_USER)
Service    : $SERVICE_NAME
Launches   : node apps/cli/lib/bin.js ${WEB_ARGS[*]}
            (equals: pnpm dsh ${WEB_ARGS[*]})

Try it manually first (foreground, logs on your terminal):
  runuser -u $RUN_USER -- env HOME=$RUN_HOME DSH_HOME=$DSH_HOME \\
    $NODE_BIN $CHECKOUT/apps/cli/lib/bin.js ${WEB_ARGS[*]}

Then watch the service:
  systemctl status $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f

API key: so agents can call the DeepSeek API, put your key in $DSH_HOME/.env
  DEEPSEEK_API_KEY=sk-...
(or use: sudo -u $RUN_USER ... dsh credentials set <name>). Never leave a
plaintext key in a world-readable file.

Collab (web-collab) operator config: before users can sign in, add the OAuth
credentials to the profile's user-layer patch by id:
  $DSH_HOME/profiles/web-collab/cordis.patch.yml
    - update: { id: collab-auth, config: { clientId: ..., clientSecret: ..., secret: ... } }
Behind plain HTTP, also set secureCookies: false; over a public network put it
behind TLS (it derives the OAuth redirect origin from each request).

Security notes:
  * The web carrier ships NO authentication layer. --host $WEB_HOST serves all
    interfaces; the '--trusted-host $TRUSTED_HOST' flag only widens the /api
    browser-trust fence to that authority. Expose on a trusted network only.
  * This machine already runs a GUI on 0.0.0.0:3080; the collab profile also
    defaults to port 3080. Stop the other instance or set DSH_WEB_PORT=<other>.
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
