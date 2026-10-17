#!/usr/bin/env bash
# Beeldkrant LXC installer for Proxmox VE, built on the community-scripts framework
# (same engine as https://github.com/community-scripts/ProxmoxVE/blob/main/ct/debian.sh).
#
# Run in a Proxmox node shell:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/narowcasting-server/main/ct/beeldkrant.sh)"
#
# The engine fetches install/beeldkrant-install.sh from this repository instead of ProxmoxVE.
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/rhisijmuiden/narowcasting-server/main}"
source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# License: MIT
# Source: https://github.com/rhisijmuiden/narowcasting-server

APP="Beeldkrant"
var_tags="${var_tags:-narrowcasting;streaming}"
var_cpu="${var_cpu:-4}"
var_ram="${var_ram:-4096}"
var_disk="${var_disk:-16}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-no}"
var_unprivileged="${var_unprivileged:-1}"
# GPU passthrough is offered (pre-selected) in the advanced wizard; used for hardware H.264 encoding.
var_gpu="${var_gpu:-yes}"
# Always open the advanced wizard (resources, network, storage, GPU passthrough). Override with mode=default.
mode="${mode:-advanced}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/beeldkrant ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi
  # Same routine as the `update` command inside the container (fetched for installs that predate it).
  local updater=/opt/beeldkrant/scripts/update.sh
  if [[ ! -f "$updater" ]]; then
    updater="$(mktemp)"
    curl -fsSL "${COMMUNITY_SCRIPTS_URL}/scripts/update.sh" -o "$updater"
  fi
  bash "$updater" || exit
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
# The app creates user "admin" with a one-time password on first start; fetch it from the container.
ADMIN_PASSWORD=""
for _ in $(seq 1 30); do
  ADMIN_PASSWORD="$(pct exec "$CTID" -- cat /var/lib/beeldkrant/initial-admin-password 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$ADMIN_PASSWORD" ]] && break
  sleep 2
done
echo -e "${INFO}${YW} Open the admin panel at:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:8080${CL}"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  echo -e "${INFO}${YW} Username: ${BGN}admin${CL}"
  echo -e "${INFO}${YW} One-time password: ${BGN}${ADMIN_PASSWORD}${YW} (you must change it at first login)${CL}"
else
  echo -e "${INFO}${YW} Get the one-time admin password with: ${BGN}pct exec ${CTID} -- cat /var/lib/beeldkrant/initial-admin-password${CL}"
fi
