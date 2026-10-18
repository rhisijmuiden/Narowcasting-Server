#!/usr/bin/env bash
# Installs Beeldkrant on a minimal Debian 13 machine (bare metal, a VM or a VPS), without Proxmox LXC.
# Asks nothing, so it can also be run by Build My TV Station over SSH.
#
# Run as root:
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/TV-Channel-Generator/main/install/debian.sh)"
# On a minimal Debian without curl:
#     bash -c "$(wget -qO- https://raw.githubusercontent.com/rhisijmuiden/TV-Channel-Generator/main/install/debian.sh)"
#
# Settings (environment variables):
#     BEELDKRANT_CHANNEL=stable|test   release channel (default stable: the newest GitHub release;
#                               test: every change on main). Can be changed later in the panel.
#     BEELDKRANT_REF=<branch>   install and follow another branch instead of a channel
#     PORT=<port>               port of the admin panel (default 8080)
#     GPU=intel|amd|none        install VAAPI drivers for hardware H.264 encoding (default: detect)
#
# At the end it prints the admin address, the user "admin" and a one-time password that must be
# changed at the first login. On a machine where Beeldkrant is already installed it runs `update`.
set -euo pipefail

BEELDKRANT_REPO="${BEELDKRANT_REPO:-https://github.com/rhisijmuiden/TV-Channel-Generator.git}"
BEELDKRANT_REF="${BEELDKRANT_REF:-}"
BEELDKRANT_CHANNEL="${BEELDKRANT_CHANNEL:-stable}"
PORT="${PORT:-8080}"
GPU="${GPU:-auto}"
APP_DIR=/opt/beeldkrant
DATA_DIR=/var/lib/beeldkrant

c_info="\e[1;34m"; c_ok="\e[1;32m"; c_warn="\e[1;33m"; c_err="\e[1;31m"; c_off="\e[0m"
info() { echo -e "${c_info}[i]${c_off} $*"; }
ok()   { echo -e "${c_ok}[✓]${c_off} $*"; }
warn() { echo -e "${c_warn}[!]${c_off} $*"; }
die()  { echo -e "${c_err}[✗]${c_off} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this script as root."
[[ -r /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "This installer is for Debian 13. Found: ${PRETTY_NAME:-unknown}."
[[ "${VERSION_ID:-}" == "13" ]] || warn "This installer is made for Debian 13; found ${PRETTY_NAME:-unknown}. Continuing anyway."

if [[ -d "$APP_DIR/.git" ]]; then
  info "Beeldkrant is already installed; updating it instead."
  exec bash "$APP_DIR/scripts/update.sh"
fi

export DEBIAN_FRONTEND=noninteractive
info "Installing packages (this takes a while: Chromium, ffmpeg and fonts)"
apt-get update -qq
apt-get install -y -qq \
  git ca-certificates curl \
  ffmpeg chromium xvfb pulseaudio \
  fonts-dejavu fonts-liberation2 fonts-noto-core fonts-noto-color-emoji \
  nodejs npm >/dev/null
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node.js 18 or newer is needed; Debian installed $(node -v)."
ok "Installed packages and Node.js $(node -v)"

# Hardware H.264 encoding through VAAPI when a GPU is passed through to this machine.
if [[ "$GPU" == "auto" ]]; then
  GPU=none
  if [[ -e /dev/dri/renderD128 ]] && command -v lspci >/dev/null; then
    lspci | grep -qi 'VGA.*Intel' && GPU=intel
    lspci | grep -qiE 'VGA.*(AMD|ATI)' && GPU=amd
  elif [[ -e /dev/dri/renderD128 ]]; then
    warn "A GPU is present, but lspci is missing to tell which. Run again with GPU=intel or GPU=amd for hardware encoding."
  fi
fi
case "$GPU" in
  intel) apt-get install -y -qq intel-media-va-driver vainfo >/dev/null && ok "Installed Intel VAAPI drivers" ;;
  amd) apt-get install -y -qq mesa-va-drivers vainfo >/dev/null && ok "Installed AMD VAAPI drivers" ;;
  none) info "No GPU drivers installed; Beeldkrant encodes on the CPU" ;;
  *) die "Unknown GPU=$GPU (use intel, amd or none)." ;;
esac

info "Creating service user"
id beeldkrant &>/dev/null || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin beeldkrant
install -d -o beeldkrant -g beeldkrant "$DATA_DIR"
for grp in video render; do getent group "$grp" >/dev/null && usermod -aG "$grp" beeldkrant; done
ok "Created service user"

# What to install: the pinned branch, the newest release (stable) or main (test, or no release yet).
[[ "$BEELDKRANT_CHANNEL" == "test" ]] || BEELDKRANT_CHANNEL="stable"
CLONE_REF="$BEELDKRANT_REF"
if [[ -z "$CLONE_REF" && "$BEELDKRANT_CHANNEL" == "stable" ]]; then
  CLONE_REF="$(git ls-remote --tags --refs "$BEELDKRANT_REPO" 'refs/tags/v*' | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
fi
CLONE_REF="${CLONE_REF:-main}"
info "Installing Beeldkrant ($CLONE_REF, ${BEELDKRANT_REF:+branch }${BEELDKRANT_REF:-$BEELDKRANT_CHANNEL channel})"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$CLONE_REF" "$BEELDKRANT_REPO" "$APP_DIR"
echo "$BEELDKRANT_CHANNEL" >"$DATA_DIR/update-channel"
chown beeldkrant:beeldkrant "$DATA_DIR/update-channel"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R beeldkrant:beeldkrant "$APP_DIR"
ok "Installed Beeldkrant"

info "Creating service"
{
  [[ -n "$BEELDKRANT_REF" ]] && echo "BEELDKRANT_REF=$BEELDKRANT_REF"
  [[ "$PORT" != "8080" ]] && echo "PORT=$PORT"
  true
} >/etc/default/beeldkrant
install -m 0644 "$APP_DIR/deploy/beeldkrant.service" /etc/systemd/system/beeldkrant.service
# The `update` command, and the units that let the admin panel start it.
install -m 0755 "$APP_DIR/scripts/update.sh" /usr/bin/update
# `beeldkrant-station`: connects Beeldkrant to Build My TV Station (see the README).
install -m 0755 "$APP_DIR/scripts/station.sh" /usr/bin/beeldkrant-station
install -m 0644 "$APP_DIR/deploy/beeldkrant-update.path" "$APP_DIR/deploy/beeldkrant-update.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet --now beeldkrant beeldkrant-update.path
ok "Started service"

ADMIN_PASSWORD=""
for _ in $(seq 1 30); do
  ADMIN_PASSWORD="$(tr -d '[:space:]' <"$DATA_DIR/initial-admin-password" 2>/dev/null || true)"
  [[ -n "$ADMIN_PASSWORD" ]] && break
  sleep 1
done
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo
ok "Beeldkrant is installed."
echo -e "    Admin panel:        ${c_ok}http://${IP:-<this-machine>}:${PORT}${c_off}"
echo -e "    User name:          ${c_ok}admin${c_off}"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  echo -e "    One-time password:  ${c_ok}${ADMIN_PASSWORD}${c_off} (you must change it at the first login)"
else
  warn "The one-time password is not there yet. Show it with: cat $DATA_DIR/initial-admin-password"
fi
echo "    Update later with:  update"
