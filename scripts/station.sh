#!/usr/bin/env bash
# Connects Beeldkrant to Build My TV Station (station contract version 1, see
# https://github.com/rhisijmuiden/BulldMyTVStation/blob/main/docs/station-contract.md).
# Installed as /usr/bin/beeldkrant-station; the station panel runs it as root after the installer.
#
#   beeldkrant-station                 apply the STATION_* settings below and write station.json
#   beeldkrant-station --reset-admin   also give the user "admin" a new one-time password
#
# Settings (environment variables). One that is not set stays as it is; set to "" it is cleared.
#     STATION_SERVICE_TOKEN=<token>      Bearer token that is an admin on /api (at least 32 characters)
#     STATION_BASE_PATH=/channel1        serve Beeldkrant under this path ("/" or "" for the root)
#     STATION_PUBLIC_URL=<url>           public address, e.g. https://tv.example.com/channel1
#     STATION_TRUSTED_PROXIES=<list>     comma-separated IPs or CIDRs of the reverse proxy
#
# They are stored as BK_SERVICE_TOKEN, BK_BASE_PATH, BK_PUBLIC_URL and BK_TRUSTED_PROXIES in
# /etc/default/beeldkrant. The JSON of station.json goes to stdout (with "initialPassword" after
# --reset-admin); everything else goes to stderr.
set -euo pipefail

APP_DIR="${BEELDKRANT_DIR:-/opt/beeldkrant}"
ENV_FILE="${BEELDKRANT_ENV_FILE:-/etc/default/beeldkrant}"
SERVICE="beeldkrant"
SERVICE_USER="beeldkrant"
RESET_ADMIN=0

if [[ -t 2 ]]; then GN=$'\e[32m'; YW=$'\e[33m'; RD=$'\e[31m'; CL=$'\e[0m'; else GN=''; YW=''; RD=''; CL=''; fi
info() { echo -e "${YW}▶${CL} $*" >&2; }
ok() { echo -e "${GN}✔${CL} $*" >&2; }
die() { echo -e "${RD}✖${CL} $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --reset-admin) RESET_ADMIN=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    *) die "Unknown option: $arg (use --reset-admin)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run beeldkrant-station as root."
[[ -f "$APP_DIR/server/index.js" ]] || die "No Beeldkrant installation found in $APP_DIR."
command -v node >/dev/null || die "Node.js is not installed."

# ---------- check the input ----------
# Values are written unquoted, so the env file stays readable for systemd and for `source`.
if [[ -n "${STATION_SERVICE_TOKEN+x}" && -n "$STATION_SERVICE_TOKEN" ]]; then
  [[ ${#STATION_SERVICE_TOKEN} -ge 32 ]] || die "STATION_SERVICE_TOKEN must be at least 32 characters."
  [[ "$STATION_SERVICE_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "STATION_SERVICE_TOKEN may only hold letters, digits and . _ ~ + / = -"
fi
if [[ -n "${STATION_BASE_PATH+x}" ]]; then
  while [[ "$STATION_BASE_PATH" == */ ]]; do STATION_BASE_PATH="${STATION_BASE_PATH%/}"; done
  if [[ -n "$STATION_BASE_PATH" ]]; then
    [[ "$STATION_BASE_PATH" == /* ]] || STATION_BASE_PATH="/$STATION_BASE_PATH"
    [[ "$STATION_BASE_PATH" =~ ^(/[A-Za-z0-9._~-]+)+$ && ! "$STATION_BASE_PATH" =~ /\.\.?(/|$) ]] || die "STATION_BASE_PATH is not a valid path: $STATION_BASE_PATH"
  fi
fi
if [[ -n "${STATION_PUBLIC_URL+x}" ]]; then
  while [[ "$STATION_PUBLIC_URL" == */ ]]; do STATION_PUBLIC_URL="${STATION_PUBLIC_URL%/}"; done
  [[ -z "$STATION_PUBLIC_URL" || "$STATION_PUBLIC_URL" =~ ^https?://[^[:space:]\"\'\`\$\\]+$ ]] || die "STATION_PUBLIC_URL must be an http:// or https:// address."
fi
if [[ -n "${STATION_TRUSTED_PROXIES+x}" ]]; then
  STATION_TRUSTED_PROXIES="${STATION_TRUSTED_PROXIES// /}"
  [[ "$STATION_TRUSTED_PROXIES" =~ ^[0-9A-Fa-f.:/,]*$ ]] || die "STATION_TRUSTED_PROXIES must be IP addresses or CIDRs, separated by commas."
  # The same check the server does, so a typo does not stop Beeldkrant from starting.
  BK_TRUSTED_PROXIES="$STATION_TRUSTED_PROXIES" node -e "require('$APP_DIR/server/station.js')" 2>/dev/null \
    || die "STATION_TRUSTED_PROXIES has an entry that is not an IP address or CIDR: $STATION_TRUSTED_PROXIES"
fi

# ---------- 1. store the settings ----------
OLD_ENV="$(cat "$ENV_FILE" 2>/dev/null || true)"
NEW_ENV="$OLD_ENV"
# set_var NAME: takes the value from STATION_<NAME> when that is set; an empty value removes the line.
set_var() {
  local station="STATION_$1" key="BK_$1"
  [[ -n "${!station+x}" ]] || return 0
  NEW_ENV="$(grep -v "^${key}=" <<<"$NEW_ENV" || true)"
  [[ -n "${!station}" ]] && NEW_ENV="${NEW_ENV:+$NEW_ENV$'\n'}${key}=${!station}"
  return 0
}
set_var SERVICE_TOKEN
set_var BASE_PATH
set_var PUBLIC_URL
set_var TRUSTED_PROXIES

CHANGED=0
if [[ "$NEW_ENV" != "$OLD_ENV" ]]; then
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  [[ -n "$NEW_ENV" ]] && printf '%s\n' "$NEW_ENV" >"$tmp"
  mv -f "$tmp" "$ENV_FILE"
  CHANGED=1
  info "Stored the station settings in $ENV_FILE"
fi
# It holds the service token: root and the service user only.
if [[ -f "$ENV_FILE" ]]; then
  chmod 0640 "$ENV_FILE"
  getent group "$SERVICE_USER" >/dev/null && chgrp "$SERVICE_USER" "$ENV_FILE"
fi

# The values the service starts with.
env_value() { grep "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
DATA_DIR="$(env_value DATA_DIR)"; DATA_DIR="${DATA_DIR:-/var/lib/beeldkrant}"
BASE_PATH="$(env_value BK_BASE_PATH)"
TOKEN="$(env_value BK_SERVICE_TOKEN)"

# ---------- 2. reset the admin password ----------
INITIAL_PASSWORD=""
if [[ $RESET_ADMIN -eq 1 ]]; then
  info "Setting a new one-time password for the user admin"
  # The service writes the same data file, so it is stopped meanwhile.
  systemctl stop "$SERVICE" || true
  INITIAL_PASSWORD="$(runuser -u "$SERVICE_USER" -- env DATA_DIR="$DATA_DIR" node "$APP_DIR/server/reset-admin.js")" \
    || { systemctl start "$SERVICE" || true; die "Could not reset the admin password."; }
  CHANGED=1
fi

# ---------- 3. restart and wait for /healthz ----------
if [[ $CHANGED -eq 1 ]] || ! systemctl is-active --quiet "$SERVICE"; then
  info "Restarting Beeldkrant"
  systemctl restart "$SERVICE" || die "Beeldkrant did not start. See: journalctl -u $SERVICE -n 50"
fi

# Settings → Application can move the admin panel to another port than PORT.
PORT="$(node -e "try { const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).settings || {}; console.log(Number(s.port) || 0); } catch { console.log(0); }" "$DATA_DIR/data.json")"
[[ "$PORT" != "0" ]] || PORT="$(env_value PORT)"
PORT="${PORT:-8080}"

HEALTH=""
for _ in $(seq 1 60); do
  HEALTH="$(node -e "fetch(process.argv[1]).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => console.log(t), () => process.exit(1))" "http://127.0.0.1:${PORT}${BASE_PATH}/healthz" 2>/dev/null)" && break
  HEALTH=""
  sleep 1
done
[[ -n "$HEALTH" ]] || die "Beeldkrant did not answer on http://127.0.0.1:${PORT}${BASE_PATH}/healthz within 60 seconds. See: journalctl -u $SERVICE -n 50"
ok "Beeldkrant answers on port $PORT${BASE_PATH:+ under $BASE_PATH}"

# ---------- 4. station.json ----------
IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | head -n 1 || true)"
STATION_JSON="$(HEALTH="$HEALTH" PORT="$PORT" BASE_PATH="$BASE_PATH" IP="${IP:-127.0.0.1}" HAS_TOKEN="${TOKEN:+1}" node -e "
  const e = process.env;
  const health = JSON.parse(e.HEALTH);
  console.log(JSON.stringify({
    contract: health.contract,
    app: 'beeldkrant',
    version: health.version,
    port: Number(e.PORT),
    basePath: e.BASE_PATH || '/',
    adminUrl: 'http://' + e.IP + ':' + e.PORT + e.BASE_PATH + '/',
    adminUser: 'admin',
    apiBase: e.BASE_PATH + '/api',
    serviceToken: !!e.HAS_TOKEN,
    ports: {},
  }, null, 2));
")"
tmp="$(mktemp "$DATA_DIR/station.json.XXXXXX")"
printf '%s\n' "$STATION_JSON" >"$tmp"
chmod 0600 "$tmp"
getent passwd "$SERVICE_USER" >/dev/null && chown "$SERVICE_USER:$SERVICE_USER" "$tmp"
mv -f "$tmp" "$DATA_DIR/station.json"
ok "Wrote $DATA_DIR/station.json"

if [[ -n "$INITIAL_PASSWORD" ]]; then
  INITIAL_PASSWORD="$INITIAL_PASSWORD" STATION_JSON="$STATION_JSON" node -e "
    console.log(JSON.stringify({ ...JSON.parse(process.env.STATION_JSON), initialPassword: process.env.INITIAL_PASSWORD }, null, 2));
  "
else
  printf '%s\n' "$STATION_JSON"
fi
