# Beeldkrant

A narrowcasting "beeldkrant" (picture newspaper) generator. You build playouts of scenes in a web admin panel, Beeldkrant renders them and pushes the result as an **RTMP or SRT stream** to a stream server of your choice. It is not a streaming server itself: it only produces and sends the stream.

- Admin panel on port **8080**
- Runs in a **Debian 13 LXC container** on Proxmox VE, installed with one command from the Proxmox shell
- Everything (code, UI, docs) in English

## Install on Proxmox VE

Run this in the shell of a Proxmox node:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/narowcasting-server/main/ct/beeldkrant.sh)"
```

The script uses the [community-scripts](https://github.com/community-scripts/ProxmoxVE) engine (the same one behind `ct/debian.sh`) and opens the **advanced wizard** by default, so you choose:

- CPU cores, RAM and disk size (defaults: 4 cores, 4096 MB, 16 GB)
- network, storage, container ID, hostname, SSH and so on
- **GPU passthrough** (Intel/AMD via VAAPI, NVIDIA via NVENC) for hardware H.264 encoding

At the end it prints the admin URL (`http://<container-ip>:8080`) and a **one-time password** for the user `admin`. You must change that password at the first login. If you missed it:

```bash
pct exec <CTID> -- cat /var/lib/beeldkrant/initial-admin-password
```

### Updating

Open the shell of the container and run:

```bash
update
```

It fetches the latest version, installs it and restarts Beeldkrant, or tells you it is already up to date.

The admin panel checks for a new version once a day. Admins then see a notice with an **Update now** button, which runs the same update; *System → Info* shows the version, build and changelog (and what a new version brings), with *Check now* and the update button. The panel starts the update through the `beeldkrant-update.path` and `beeldkrant-update.service` systemd units, so the web server itself never needs root. Your playouts, media and settings in `/var/lib/beeldkrant` are kept. `update --force` reinstalls the current version. To follow another branch, put `BEELDKRANT_REF=<branch>` in `/etc/default/beeldkrant`.

Useful overrides: `mode=default` skips the wizard, `var_gpu=no` turns GPU passthrough off, `BEELDKRANT_REF=<branch>` installs another branch.

## How it works

```
 Admin panel (:8080) ──► data.json + media
                              │
                              ▼
 Xvfb virtual display ◄── Chromium (kiosk) showing /player
 PulseAudio null sink ◄── audio from videos and background music
          │
          ▼
 ffmpeg (x11grab + pulse) ──► H.264/AAC ──► rtmp(s)://…  (FLV)
                                       └──► srt://…      (MPEG-TS)
```

The player page draws each scene with HTML/CSS at the exact pixel size of the playout. Chromium renders it on a virtual display, ffmpeg captures the screen and the audio sink and encodes the stream. If the destination drops, only the encoder reconnects; if the browser or display dies, the whole pipeline restarts with back-off. When the schedule switches to a playout with a different resolution, the pipeline is rebuilt at the new size (or scaled to a fixed output size if you choose that).

## Concepts

| Term | What it is |
| --- | --- |
| **Playout** | A channel. You pick its resolution first (1920x1080, 1280x720, 4K, portrait…), then add scenes. |
| **Scene** | One screen in the playout. Holds freely placed elements (zones) and has a duration, or moves on when its video ends. Scenes play in the order you drag them in. |
| **Element** | Text, image, video, ticker, clock, weather, web page or box, placed in pixels on the scene. |
| **Overlay** | Elements that stay on top of every scene (ticker, clock, logo). A scene can hide them. |
| **RSS scene** | A scene linked to a feed becomes a template: it plays once per feed item, filling `{{title}}`, `{{description}}`, `{{date}}`, `{{feed}}` and the feed item image. |
| **Ad block** | Plays all scenes of another playout (e.g. "Ads") after every X scenes, or at set times on chosen days. |
| **Schedule** | A weekly calendar. Drag in a day to put a playout (block of scenes) on air at that time. Weekly blocks repeat every week for a linear programme; one-off blocks on a date with a higher priority override them. Outside the blocks the default playout runs. |
| **Background music** | An uploaded audio file or an external Shoutcast/Icecast stream, with volume control. The music ducks automatically under videos that have sound. |

Transitions: fade, crossfade, cut, slide (left/right/up/down), zoom, wipe, circle and blur, per playout with an override per scene.

## Media

| Type | Formats |
| --- | --- |
| Images | jpg, png, gif, webp, svg, bmp |
| Video | mp4 (H.264), webm, mov, mkv |
| Audio | mp3, m4a, aac, ogg, wav, flac |
| External | Shoutcast/Icecast audio streams (Media → *Add audio stream*) |
| RSS / Atom | Media → *RSS feeds* |

Keep media tidy in **folders**: create folders (and subfolders) under Media, upload straight into the folder you have open, and move files by dragging them onto a folder or a breadcrumb, or with *Move*. Deleting a folder keeps its files: they move up one level. The media pickers in the scene editor browse the same folders and can search all of them.

## Stream output

Under *Stream output* you set:

- destination: `rtmp://`, `rtmps://` or `srt://` (for example `rtmp://stream.example.com/live/<key>` or `srt://host:9000?streamid=…`)
- resolution: follow the playout on air, or a fixed output size
- frame rate, video and audio bitrate
- encoder: CPU (x264), Intel/AMD GPU (VAAPI) or NVIDIA GPU (NVENC)

Start, stop and watch the stream (state, fps, bitrate and renderer log) on the dashboard.

## Look and feel

Under *Settings* you can rename the panel (shown in the menu, on the login page and in the browser tab). Each user picks a light or dark theme, or *Auto* to follow the device, with the switch at the bottom of the menu.

## Backups

Under *System → Backups* (admins only):

- **What to back up**: the application (program code, without installed packages), the database (playouts, scenes, schedule, feeds, media list and folders, users and settings) and the media (all files in all folders). Put everything in one archive, or make a separate archive per part so the large media stays apart.
- **Schedule**: automatic backups on chosen days at a set time (in the time zone from *Settings*), plus a *Back up now* button.
- **External location**: FTP, FTPS (FTP over TLS) or SCP/SFTP over SSH with a password or a private key. *Test connection* checks the login and the folder. Copies are uploaded after each backup and the oldest are removed beyond the number to keep. Passwords and keys stay on the server and are never sent back to the browser.
- **Restore**: pick a backup on this server or on the external location and choose which parts to put back. Restoring the application hands over to the update service, which replaces the code, reinstalls packages and restarts Beeldkrant (from the shell: `update --restore-app <unpacked app folder>`).

Backups are named `beeldkrant_<date>_<time>_<parts>.tar.gz` and kept in `/var/lib/beeldkrant/backups`; backups there can also be downloaded from the panel. Each archive holds a `manifest.json` and `app/`, `database/data.json` and/or `media/`.

## Users

On first start Beeldkrant creates the user `admin` with a random one-time password (shown by the installer and kept in `DATA_DIR/initial-admin-password` until it is changed). Accounts carry a role (`admin`, `editor`, `viewer`); a user management screen for creating more accounts is planned.

## Manual install (any Debian 13 machine)

```bash
apt install -y git ffmpeg chromium xvfb pulseaudio fonts-dejavu fonts-noto-color-emoji nodejs npm
git clone https://github.com/rhisijmuiden/narowcasting-server /opt/beeldkrant
cd /opt/beeldkrant && npm ci --omit=dev
DATA_DIR=/var/lib/beeldkrant node server/index.js
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Admin panel port |
| `DATA_DIR` | `./data` | Database (`data.json`) and uploaded media |
| `CHROMIUM_PATH` | auto | Browser used for rendering |
| `FFMPEG_PATH` | auto | ffmpeg binary |
| `BK_DISPLAY` | `:99` | Virtual X display |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | GPU device for VAAPI |
| `MAX_UPLOAD_MB` | `2048` | Upload size limit |
| `BK_INITIAL_PASSWORD` | random | One-time admin password on first start |

## Repository layout

```
ct/beeldkrant.sh               Proxmox host script (creates the LXC)
install/beeldkrant-install.sh  Runs inside the container
scripts/update.sh              The `update` command inside the container
server/                        Node.js server: API, auth, schedule, feeds, stream pipeline
public/admin/                  Admin panel (plain JS, no build step)
public/player/                 Player page and the shared scene renderer
```

## Notes

- The installer downloads from this repository, so the repository must be public (or point `COMMUNITY_SCRIPTS_URL` and `BEELDKRANT_REPO` at a reachable copy).
- Weather comes from [Open-Meteo](https://open-meteo.com) and needs internet access from the container; RSS feeds and audio streams too.
- Some websites refuse to be shown inside another page, so not every URL works as a web page element.

## License

MIT
