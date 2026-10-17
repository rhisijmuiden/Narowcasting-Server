#!/usr/bin/env bash
# Runs inside the new Debian 13 container; called by ct/beeldkrant.sh through the community-scripts engine.
# License: MIT
# Source: https://github.com/rhisijmuiden/TV-Channel-Generator

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

BEELDKRANT_REPO="${BEELDKRANT_REPO:-https://github.com/rhisijmuiden/TV-Channel-Generator.git}"
BEELDKRANT_REF="${BEELDKRANT_REF:-main}"

msg_info "Installing Dependencies"
$STD apt-get install -y \
  git ca-certificates curl \
  ffmpeg chromium xvfb pulseaudio \
  fonts-dejavu fonts-liberation2 fonts-noto-core fonts-noto-color-emoji
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs

msg_info "Creating service user"
useradd --system --home-dir /var/lib/beeldkrant --shell /usr/sbin/nologin beeldkrant 2>/dev/null || true
mkdir -p /var/lib/beeldkrant
chown -R beeldkrant:beeldkrant /var/lib/beeldkrant
msg_ok "Created service user"

# Intel/AMD (VAAPI) or NVIDIA (NVENC) drivers when a GPU was passed through; no-op otherwise.
setup_hwaccel "beeldkrant"
for grp in video render; do getent group "$grp" >/dev/null && usermod -aG "$grp" beeldkrant; done

msg_info "Installing Beeldkrant"
$STD git clone --depth 1 --branch "$BEELDKRANT_REF" "$BEELDKRANT_REPO" /opt/beeldkrant
cd /opt/beeldkrant || exit
$STD npm ci --omit=dev
chown -R beeldkrant:beeldkrant /opt/beeldkrant
msg_ok "Installed Beeldkrant"

msg_info "Creating Service"
install -m 0644 /opt/beeldkrant/deploy/beeldkrant.service /etc/systemd/system/beeldkrant.service
systemctl daemon-reload
systemctl enable -q --now beeldkrant
msg_ok "Created Service"

motd_ssh
customize

# Our own `update` command (replaces the generic one customize() writes): updates Beeldkrant in place.
install -m 0755 /opt/beeldkrant/scripts/update.sh /usr/bin/update
# Lets the admin panel start that same update.
install -m 0644 /opt/beeldkrant/deploy/beeldkrant-update.path /opt/beeldkrant/deploy/beeldkrant-update.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now beeldkrant-update.path
[[ "$BEELDKRANT_REF" != "main" ]] && echo "BEELDKRANT_REF=$BEELDKRANT_REF" >/etc/default/beeldkrant

cleanup_lxc
