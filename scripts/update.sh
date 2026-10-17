#!/usr/bin/env bash
# Updates Beeldkrant to the latest version. Installed as /usr/bin/update in the LXC container,
# so running `update` in the container shell is all that is needed.
#
#   update                      update to the latest version of the configured branch
#   update --force              reinstall even when already up to date
#   update --restore-app DIR    put back the application from an unpacked backup
#   update --request FILE       do what the admin panel asked for in FILE (used by beeldkrant-update.service)
set -euo pipefail

APP_DIR="${BEELDKRANT_DIR:-/opt/beeldkrant}"
[[ -f /etc/default/beeldkrant ]] && source /etc/default/beeldkrant
REF="${BEELDKRANT_REF:-main}"
SERVICE="beeldkrant"
FORCE=0
RESTORE_DIR=""
case "${1:-}" in
  --force) FORCE=1 ;;
  --restore-app) RESTORE_DIR="${2:-}" ;;
  --request)
    # The panel writes "restore-app <dir>" for a restore; anything else means update.
    REQUEST="$(cat "${2:-}" 2>/dev/null || true)"
    rm -f "${2:-}"
    [[ "$REQUEST" == restore-app\ * ]] && RESTORE_DIR="${REQUEST#restore-app }"
    ;;
esac

if [[ -t 1 ]]; then GN=$'\e[32m'; YW=$'\e[33m'; RD=$'\e[31m'; CL=$'\e[0m'; else GN=''; YW=''; RD=''; CL=''; fi
info() { echo -e "${YW}▶${CL} $*"; }
ok() { echo -e "${GN}✔${CL} $*"; }
die() { echo -e "${RD}✖${CL} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run update as root."
[[ -d "$APP_DIR/.git" || -n "$RESTORE_DIR" ]] || die "No Beeldkrant installation found in $APP_DIR."

# The checkout belongs to the service user; let root's git work on it.
git_() { git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }
version() { node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo "?"; }

# systemd units that let the admin panel start an update (see deploy/).
install_units() {
  [[ -d /etc/systemd/system && -d "$APP_DIR/deploy" ]] || return 0
  install -m 0644 "$APP_DIR/deploy/beeldkrant-update.path" "$APP_DIR/deploy/beeldkrant-update.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --quiet --now beeldkrant-update.path || true
}

# Installs dependencies, fixes ownership, refreshes this command and starts the service.
finish() {
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || {
    systemctl start "$SERVICE" || true
    die "Installing dependencies failed; Beeldkrant was restarted with the files it has now."
  }
  chown -R "$SERVICE:$SERVICE" "$APP_DIR"
  # Keep this command, beeldkrant-station and the panel's update service current.
  install -m 0755 "$APP_DIR/scripts/update.sh" /usr/bin/update
  [[ -f "$APP_DIR/scripts/station.sh" ]] && install -m 0755 "$APP_DIR/scripts/station.sh" /usr/bin/beeldkrant-station
  install_units

  info "Starting Beeldkrant"
  systemctl start "$SERVICE"
  sleep 2
  systemctl is-active --quiet "$SERVICE" || die "Beeldkrant did not start. See: journalctl -u $SERVICE -n 50"
}

if [[ -n "$RESTORE_DIR" ]]; then
  [[ -f "$RESTORE_DIR/package.json" ]] || die "No Beeldkrant application found in $RESTORE_DIR."
  OLD_VERSION="$(version)"
  info "Stopping Beeldkrant"
  systemctl stop "$SERVICE" || true
  info "Restoring the application from the backup"
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  cp -a "$RESTORE_DIR/." "$APP_DIR/"
  rm -rf "$RESTORE_DIR"
  finish
  ok "Restored Beeldkrant ${OLD_VERSION} → $(version) from the backup."
  exit 0
fi

info "Checking for updates ($REF)"
# The repository was renamed; GitHub redirects the old address, but point installs at the new one.
case "$(git_ remote get-url origin 2>/dev/null)" in
  *rhisijmuiden/narowcasting-server*) git_ remote set-url origin https://github.com/rhisijmuiden/TV-Channel-Generator.git ;;
esac
git_ fetch --quiet --depth 1 origin "$REF" || die "Could not reach the repository."
CURRENT="$(git_ rev-parse HEAD)"
LATEST="$(git_ rev-parse FETCH_HEAD)"
OLD_VERSION="$(version)"

if [[ "$CURRENT" == "$LATEST" && $FORCE -eq 0 ]]; then
  ok "Beeldkrant ${OLD_VERSION} (${CURRENT:0:7}) is already up to date."
  exit 0
fi

info "Stopping Beeldkrant"
systemctl stop "$SERVICE" || true

info "Installing ${LATEST:0:7}"
git_ reset --quiet --hard FETCH_HEAD
finish

ok "Updated Beeldkrant ${OLD_VERSION} (${CURRENT:0:7}) → $(version) (${LATEST:0:7})."
