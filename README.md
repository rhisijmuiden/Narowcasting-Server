# Beeldkrant

A narrowcasting "beeldkrant" (picture newspaper) generator. You build playouts of scenes in a web admin panel, Beeldkrant renders them and pushes the result as **RTMP(S) or SRT streams** to stream servers, YouTube and Facebook, several at the same time. It is not a streaming server itself: it only produces and sends the streams.

![Dashboard with the stream on air, the live preview and the renderer log](docs/screenshots/dashboard.png)

- Admin panel on port **8080**
- Runs in a **Debian 13 LXC container** on Proxmox VE, installed with one command from the Proxmox shell, or on a [Debian 13 machine or VM](#install-on-a-debian-13-machine-or-vm)
- Everything (code, UI, docs) in English

Contents: [Install](#install-on-proxmox-ve) · [Dashboard](#dashboard-and-statistics) · [Playouts](#playouts-and-scenes) · [Media](#media) · [Schedule](#schedule) · [Outputs](#outputs) · [Routing](#routing) · [Settings](#settings-and-your-account) · [Backups](#backups) · [Users and roles](#users-and-roles) · [Updating](#updating)

## Install on Proxmox VE

Run this in the shell of a Proxmox node:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/TV-Channel-Generator/main/ct/beeldkrant.sh)"
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

The admin panel checks for a new version once a day. Admins then see a notice with an **Update now** button, which runs the same update; The **Info** button at the bottom left of the menu shows the version, build and changelog (and what a new version brings), with *Check now* and the update button. Before updating, the panel offers to make a local backup of the application and database, optionally with the media; the update only starts when that backup succeeded. The panel starts the update through the `beeldkrant-update.path` and `beeldkrant-update.service` systemd units, so the web server itself never needs root. Your playouts, media and settings in `/var/lib/beeldkrant` are kept. `update --force` reinstalls the current version. To follow another branch, put `BEELDKRANT_REF=<branch>` in `/etc/default/beeldkrant`.

Before an update the panel asks whether to make a local backup first:

<p>
  <img src="docs/screenshots/info.png" alt="Info page with the version, build and changelog" width="49%">
  <img src="docs/screenshots/update-dialog.png" alt="Update dialog with the backup options" width="49%">
</p>

Useful overrides: `mode=default` skips the wizard, `var_gpu=no` turns GPU passthrough off, `BEELDKRANT_REF=<branch>` installs another branch.

## How it works

```
 Admin panel (:8080) ──► data.json + media
                              │
                              ▼              one pipeline per playout on air
 Xvfb virtual display ◄── Chromium (kiosk) showing /player
 PulseAudio null sink ◄── audio from videos and background music
          │
          ▼
 ffmpeg (x11grab + pulse) ──► H.264/AAC ──► MPEG-TS over local UDP
                                                   │  fan-out
                         ┌─────────────────────────┼─────────────────────────┐
                         ▼                         ▼                         ▼
                 relay ──► rtmp(s)://…     relay ──► YouTube          relay ──► srt://…
```

The player page draws each scene with HTML/CSS at the exact pixel size of the playout. Chromium renders it on a virtual display, ffmpeg captures the screen and the audio sink and encodes the stream once. A small fan-out in the server hands that stream to one relay per output, which copies it without re-encoding to its destination (RTMP/RTMPS as FLV, SRT as MPEG-TS). Each output connects, drops and reconnects on its own. If the browser or display dies, that pipeline restarts with back-off. When the schedule switches to a playout with a different resolution, the pipeline is rebuilt at the new size (or scaled to a fixed output size if you choose that).

The schedule has one pipeline. Every playout that an output is routed to directly (see [Routing](#routing)) gets a pipeline of its own, with its own display, audio sink and encoder.

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

## Dashboard and statistics

The dashboard shows what is on air: the playout, any playouts routed to their own outputs, the resolution, fps, bitrate and the state of every output, with a live preview and the renderer log. Start, stop and restart the stream here. *Dashboard → Statistics* shows the load, CPU, memory, the outgoing stream and network traffic in Mbit/s and the free disk space, with charts of the last 15 minutes. Hover a chart to read a value.

<p>
  <img src="docs/screenshots/statistics.png" alt="Statistics with load, stream bitrate, network and disk" width="49%">
  <img src="docs/screenshots/dashboard-light.png" alt="The dashboard in the light theme" width="49%">
</p>

## Playouts and scenes

*Playouts* lists your channels with their resolution, number of scenes, whether the schedule has them on air and how many outputs they are routed to. The editor has a scene list on the left, the canvas in the middle and the properties of the selected scene or element on the right. *Overlays* holds what stays on top of every scene; *Playout settings* holds the transition, background music and ad blocks.

<p>
  <img src="docs/screenshots/playouts.png" alt="Playouts list with Preview, Clone and Delete" width="49%">
  <img src="docs/screenshots/playout-editor.png" alt="Scene editor with scenes, canvas and properties" width="49%">
</p>
<p>
  <img src="docs/screenshots/playout-overlays.png" alt="Overlays: a ticker and a clock on top of every scene" width="49%">
  <img src="docs/screenshots/playout-settings.png" alt="Playout settings with background music and ad blocks" width="49%">
</p>

### The scene editor

The top bar switches between *Scenes*, *Overlays* and *Playout settings*, and holds *Preview*, *Clone* and *Save* (or Ctrl+S); "Unsaved changes" shows until you save. Add elements with the buttons above the canvas, grouped in *Text and info* (text, ticker, clock, weather, RSS feed), *Media* (image, video, photo carousel, video carousel, IP camera) and *Other* (box, web page). The scene list shows a thumbnail of every scene with a switch to turn it off; the layer list shows the elements of the scene, with an eye to hide one and a lock to stop it moving.

**Photo carousel** shows several photos in one place, one after another. Choose the time per photo, the transition (fade, slide left, slide up, zoom or cut) and the order: *In this order* or *Random*. *Add photos* opens the media folders, where you tick several photos at once; change the order by dragging the rows or with the arrows. **Video carousel** does the same with videos: they play back to back in your order or at random, with or without sound, and the editor shows their total length.

<p>
  <img src="docs/screenshots/editor-photo-carousel.png" alt="Photo carousel selected, with its photo list, order and transition" width="49%">
  <img src="docs/screenshots/editor-add-photos.png" alt="Adding several photos to a carousel from the media folders" width="49%">
</p>
<p>
  <img src="docs/screenshots/editor-video-carousel.png" alt="Video carousel with two videos in a random order" width="49%">
  <img src="docs/screenshots/editor-rss.png" alt="RSS feed element as a list, with its layout options" width="49%">
</p>

**RSS feed** shows a whole feed on a scene with photos, titles, text and dates. Pick a layout: a *list*, a *grid* of cards or *one item at a time*, then how many items go on a page and how long each page stays. With *Move on: when the media has played* the scene moves on after all pages (and after one full round of a carousel, or when a video has ended).

<p>
  <img src="docs/screenshots/player-rss-list.png" alt="RSS list on air" width="32%">
  <img src="docs/screenshots/player-rss-grid.png" alt="RSS grid on air" width="32%">
  <img src="docs/screenshots/player-rss-single.png" alt="One RSS item at a time on air" width="32%">
</p>

**Clone** (in the list and in the editor) makes a full copy of a playout: every scene, overlay, ad block and the music. Use it for a variant, such as a clean feed without overlays or ads, and route that copy to its own output.

![Clone dialog: name the copy](docs/screenshots/playout-clone.png)

## Media

| Type | Formats |
| --- | --- |
| Images | jpg, png, gif, webp, svg, bmp |
| Video | mp4 (H.264), webm, mov, mkv |
| Audio | mp3, m4a, aac, ogg, wav, flac |
| Input streams | Shoutcast/Icecast audio streams (Media management → *Input streams*) |
| RSS / Atom | Media management → *RSS feeds* |
| IP cameras | RTSP, RTMP, RTMPS and RTP (Media management → *IP cameras*) |

*Media management* opens with an overview of everything you have: files and folders, video, audio, ads, RSS feeds and input streams. Keep media tidy in **folders**: create folders (and subfolders) under *Media folders*, upload straight into the folder you have open, and move files by dragging them onto a folder or a breadcrumb, or with *Move*. Deleting a folder keeps its files: they move up one level. The media pickers in the scene editor browse the same folders and can search all of them. *Video*, *Audio* and *Ads* list those files across all folders. Mark a file as an ad (commercial) with its *Ad* button, or upload under *Ads* to mark new files straight away.

**Uploading**: choose or drop as many files as you like. A panel at the bottom right lists every file with its own progress bar, speed and time left, plus the total; files go up three at a time, and you can cancel or retry each one. The panel stays while you move to other pages, so you can keep working.

<p>
  <img src="docs/screenshots/media-uploads.png" alt="Upload panel with several files uploading, each with speed and time left" width="49%">
  <img src="docs/screenshots/media-uploads-done.png" alt="Upload panel after the uploads, with a cancelled and a failed file" width="49%">
</p>
<p>
  <img src="docs/screenshots/media-overview.png" alt="Media management overview" width="49%">
  <img src="docs/screenshots/media-folders.png" alt="Media folders with upload and folders" width="49%">
</p>
<p>
  <img src="docs/screenshots/media-video.png" alt="Video across all folders" width="49%">
  <img src="docs/screenshots/media-ads.png" alt="Ads: files marked as commercials" width="49%">
</p>

*RSS feeds* lists the feeds that RSS elements, RSS scenes and tickers use. Set per feed how many of the newest items go round (*Number of items*, 10 by default); *Test feed* shows them with their photos. *Input streams* lists the Icecast/Shoutcast streams, lets you listen to them and shows which playouts use them as background music.

<p>
  <img src="docs/screenshots/rss-feed-edit.png" alt="Editing a feed: number of items and a preview with photos" width="49%">
  <img src="docs/screenshots/rss-feeds.png" alt="RSS feeds" width="49%">
</p>
<p>
  <img src="docs/screenshots/input-streams.png" alt="Icecast/Shoutcast input streams" width="49%">
</p>

### IP cameras

*IP cameras* holds live cameras for your scenes. Add one with its protocol and address:

| Protocol | Address | Options |
| --- | --- | --- |
| RTSP | `rtsp://192.168.1.20:554/stream1` (the path differs per make) | user name and password, TCP or UDP |
| RTMP | `rtmp://192.168.1.20:1935/live/camera1` | user name and password |
| RTMPS | `rtmps://cam.example.com:443/live/camera1` | **Ignore SSL errors** for a self-signed or expired certificate |
| RTP | `rtp://0.0.0.0:5004` (or a multicast address such as `rtp://239.0.0.1:5004`) | SDP description for H.264/H.265 over RTP; MPEG-TS over RTP needs none |

**Test connection** connects once and shows what the camera sends (codec, resolution, frame rate, audio) or why it fails: connection refused, wrong user name or password, unknown path, an SSL error, or no answer. **Preview** shows the camera live with its state, frame rate and log. A camera only connects while someone watches it (a preview, or a scene on air) and reconnects by itself when it drops.

<p>
  <img src="docs/screenshots/cameras.png" alt="IP cameras: RTSP, RTMP, RTMPS and RTP cameras with their live state" width="49%">
  <img src="docs/screenshots/camera-preview.png" alt="Live preview of a camera with its frame rate and log" width="49%">
</p>
<p>
  <img src="docs/screenshots/camera-add-ssl-error.png" alt="Testing an RTMPS camera with a self-signed certificate: SSL error" width="49%">
  <img src="docs/screenshots/camera-add-rtmps.png" alt="The same camera with Ignore SSL errors ticked: connected" width="49%">
</p>

Show a camera in a scene with the **IP camera** element (under *Media* in the editor): full screen, or small as picture-in-picture. The editor shows a recent picture; on air the camera is live. The cameras of the playout on air stay connected, so a camera scene starts with a picture straight away. For RTP, open the UDP port in your firewall.

<p>
  <img src="docs/screenshots/editor-camera.png" alt="Scene with a full-screen camera and a second camera as picture-in-picture" width="49%">
  <img src="docs/screenshots/player-camera.png" alt="The camera scene on air" width="49%">
</p>
<p>
  <img src="docs/screenshots/camera-add-rtp.png" alt="Adding an RTP camera with an optional SDP description" width="49%">
</p>

## Schedule

A weekly calendar. Drag in a day to put a playout on air at that time; click a block to change its playout, times, days, dates or priority. Weekly blocks repeat every week; one-off blocks on a date with a higher priority override them. Outside the blocks the playout chosen at the top runs.

<p>
  <img src="docs/screenshots/schedule.png" alt="Weekly schedule with blocks" width="49%">
  <img src="docs/screenshots/schedule-block.png" alt="Editing a schedule block" width="49%">
</p>

## Outputs

Under *Outputs* you add every destination the stream goes to. They all send at the same time; each has its own switch, state (live, connecting, reconnecting, error), bitrate, log and, for YouTube and Facebook, a *Watch* link to the broadcast.

<p>
  <img src="docs/screenshots/outputs.png" alt="Outputs with five destinations, four of them live" width="49%">
  <img src="docs/screenshots/output-add.png" alt="Adding an output" width="49%">
</p>

Output types:

- **RTMP / RTMPS / SRT**: any server, for example `rtmp://stream.example.com/live/<key>` or `srt://host:9000?streamid=…`.
- **YouTube** and **Facebook**, in one of two ways:
  - **Connected account**: Beeldkrant creates the live broadcast (YouTube) or live video (Facebook) itself each time the output starts, with your title, description and privacy, and ends it when the output stops. On Facebook you choose your profile or a page you manage.
  - **Stream key**: paste the key from YouTube Studio or Facebook Live Producer; it is sent to `rtmps://a.rtmps.youtube.com/live2` or `rtmps://live-api-s.facebook.com:443/rtmp`.

<p>
  <img src="docs/screenshots/output-youtube.png" alt="YouTube output with a connected account" width="49%">
  <img src="docs/screenshots/output-facebook.png" alt="Facebook output going live on a page" width="49%">
</p>

**Connecting an account** works with a code, so the server needs no public address: click *Connect YouTube* or *Connect Facebook*, open the address shown on any device, enter the code and allow access. Tokens stay on the server.

This needs your own API credentials once, under *Linking settings…* (admins only):

- **YouTube**: in Google Cloud Console enable the *YouTube Data API v3*, create an OAuth client ID of type **TVs and Limited Input devices** and enter its client ID and secret. While the Google app is in testing, add your Google account as a test user. The channel must have live streaming enabled.
- **Facebook**: create an app at Meta for Developers, add Facebook Login, switch on **Login from Devices** and enter the App ID and Client token. Until Meta has reviewed the app, only people with a role on the app can go live through it. Facebook only allows going live from profiles and pages that meet its own requirements.

<p>
  <img src="docs/screenshots/connect-youtube.png" alt="Connecting YouTube with a code" width="49%">
  <img src="docs/screenshots/linking-settings.png" alt="Linking settings with the setup steps" width="49%">
</p>

The **Encoding** card sets the resolution (follow the playout, or a fixed size), frame rate, video and audio bitrate and the encoder: CPU (x264), Intel/AMD GPU (VAAPI) or NVIDIA GPU (NVENC). Each playout on air is encoded once and sent unchanged to all outputs routed to it.

## Routing

*Outputs → Routing* decides which playout goes to which output. Every output sends one source: **Schedule** (whatever the schedule has on air) or one fixed playout. The matrix has a row per playout and a column per output; click a circle to route that output. *On air now* shows the playouts that are running, their resolution and bitrate and the outputs they feed.

A typical setup sends the schedule to YouTube, Facebook and your own server, and a cloned playout without overlays (a clean feed) to another server. Outputs on the same playout share one encoder; each extra playout on air adds its own renderer and encoder, so roughly the load of one more stream. Changes apply right away while the stream runs: a playout starts when the first output is routed to it and stops when the last one leaves. Deleting a playout moves its outputs back to the schedule.

<p>
  <img src="docs/screenshots/routing.png" alt="Routing matrix with two playouts on air" width="49%">
  <img src="docs/screenshots/routing-light.png" alt="Routing in the light theme" width="49%">
</p>

## Settings and your account

Under *Settings → Application* you rename the panel (shown in the menu, on the login page and in the browser tab) and, as an admin, set the server address and the web port. A new port takes effect right away and the panel moves you there; it is stored in the database and wins over the `PORT` the service starts with. Each user picks a light or dark theme, or *Auto* to follow the device, with the switch at the bottom of the menu; your name at the bottom opens your account (theme, password, MFA and your role).

<p>
  <img src="docs/screenshots/settings-application.png" alt="Settings: application name, server address, port and region" width="49%">
  <img src="docs/screenshots/account.png" alt="Your account: theme and password" width="49%">
</p>

## Backups

Under *Settings → Backups* (admins, and users with the *Backups and restore* permission):

- **What to back up**: the application (program code, without installed packages), the database (playouts, scenes, schedule, feeds, media list and folders, users and settings) and the media (all files in all folders). Put everything in one archive, or make a separate archive per part so the large media stays apart.
- **Schedule**: automatic backups on chosen days at a set time (in the time zone from *Settings*), plus a *Back up now* button.
- **External location**: FTP, FTPS (FTP over TLS) or SCP/SFTP over SSH with a password or a private key. *Test connection* checks the login and the folder. Copies are uploaded after each backup and the oldest are removed beyond the number to keep. Passwords and keys stay on the server and are never sent back to the browser.
- **Restore**: pick a backup on this server or on the external location and choose which parts to put back. Restoring the application hands over to the update service, which replaces the code, reinstalls packages and restarts Beeldkrant (from the shell: `update --restore-app <unpacked app folder>`).

Backups are named `beeldkrant_<date>_<time>_<parts>.tar.gz` and kept in `/var/lib/beeldkrant/backups`; backups there can also be downloaded from the panel. Each archive holds a `manifest.json` and `app/`, `database/data.json` and/or `media/`.

![Backups: what to back up, schedule and external location](docs/screenshots/backups.png)
<p>
  <img src="docs/screenshots/backups-restore.png" alt="Backups on this server and on the external location" width="49%">
  <img src="docs/screenshots/backups-restore-dialog.png" alt="Restoring a backup, choosing the parts" width="49%">
</p>

## Users and roles

<img src="docs/screenshots/login.png" alt="Login page" width="49%">

On first start Beeldkrant creates the user `admin` with a random one-time password (shown by the installer and kept in `DATA_DIR/initial-admin-password` until it is changed).

Under *Settings → Users and roles* (admins only) you add, edit, disable and remove users. Every user has one of three roles:

- **Admin** can do everything, including users, SSO, security and backups.
- **User** can only change the parts you switch on for that person: *Playouts and scenes*, *Media, RSS feeds, input streams and IP cameras*, *Schedule*, *Outputs, routing and starting or stopping the stream*, *Application settings* and *Backups and restore*. Everything else is visible but read only.
- **Read only** can look at everything in the system but change nothing (a banner says so); only their own theme, password and MFA.

Beeldkrant always keeps at least one admin, and you cannot demote or remove yourself. Accounts from older versions are moved over automatically: `editor` becomes *User* with everything except settings and backups, `viewer` becomes *Read only*.

![Users and roles: role overview and the list of users](docs/screenshots/users.png)
<p>
  <img src="docs/screenshots/users-edit.png" alt="Editing a user: role, permissions, sign-in method and MFA" width="49%">
  <img src="docs/screenshots/readonly-playouts.png" alt="A read-only user sees everything but cannot change anything" width="49%">
</p>

### Microsoft Entra SSO

*Settings → Users and roles → Configure SSO* connects Beeldkrant to Microsoft Entra ID (OpenID Connect with PKCE):

1. In the Entra admin center, register an app (*App registrations → New registration*) with the redirect URI shown on the page (type *Web*), for example `https://beeldkrant.example.com/api/sso/callback`.
2. Create a client secret and copy the tenant ID, the application (client) ID and the secret into Beeldkrant.
3. Optional: give the app the *Microsoft Graph → User.Read.All* application permission (with admin consent) to search the directory and add people from Entra.
4. Optional: define app roles (for example `Beeldkrant.Admin`) and fill them in under *Role mapping*; the role is then taken from Entra at every sign-in.
5. *Test configuration* checks the tenant, the secret and Graph, then switch SSO on.

The login page then shows *Sign in with Microsoft*. Per user you choose the sign-in method, *Password* or *Microsoft Entra SSO*. With *Create users on first sign-in* on, anyone in your tenant who signs in gets an account with the default role (*Read only* unless you pick another); otherwise only users you added can sign in. *Add from Entra* on the users page searches the directory and creates SSO accounts in one go.

![Configure SSO: tenant, app, redirect URI, test, provisioning and role mapping](docs/screenshots/sso-config.png)
<p>
  <img src="docs/screenshots/users-entra-import.png" alt="Adding users from the Entra directory" width="49%">
  <img src="docs/screenshots/login-sso.png" alt="Login page with Sign in with Microsoft" width="49%">
</p>
<img src="docs/screenshots/users-add-sso.png" alt="Adding a user with Microsoft Entra SSO as the sign-in method" width="49%">

### Security: MFA and password policy

Under *Settings → Security* (admins only):

- **MFA**: per user, switch on whether a second step is required, or use *Require for everyone* / *Require for admins*. A user who must use MFA sets it up at the next sign-in with an authenticator app (Microsoft Authenticator, Google Authenticator and similar, TOTP) by scanning a QR code, and gets 8 one-time recovery codes. Anyone can also turn MFA on under their account. *Reset* removes a user's authenticator, for example after a lost phone. For SSO users, MFA is set in Entra (Conditional Access). Keep at least one admin with a password, so you can still sign in if Microsoft sign-in stops working.
- **Password policy**: the minimum length, whether a special character and/or upper and lower case letters are needed, and after how many days a password expires (0 = never). An expired password must be changed at the next sign-in. The policy does not apply to users who sign in with Microsoft Entra SSO; their password is managed by Microsoft.

After 5 wrong passwords for a user from one address, sign-in is paused for 30 seconds, doubling with each further attempt.

![Security: MFA per user and the password policy](docs/screenshots/security.png)
<p>
  <img src="docs/screenshots/login-mfa-setup.png" alt="Setting up MFA at sign-in with a QR code" width="32%">
  <img src="docs/screenshots/login-mfa-codes.png" alt="Recovery codes after setting up MFA" width="32%">
  <img src="docs/screenshots/account-mfa.png" alt="Your account: password, MFA and role" width="32%">
</p>

## Install on a Debian 13 machine or VM

To run Beeldkrant on a minimal Debian 13 machine, a VM or a VPS instead of an LXC container, run this as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/TV-Channel-Generator/main/install/debian.sh)"
```

Without curl, use `wget -qO-` instead of `curl -fsSL`. The installer asks nothing: it installs the packages (Chromium, ffmpeg, Xvfb, PulseAudio, fonts and Debian's Node.js), Beeldkrant in `/opt/beeldkrant` with its data in `/var/lib/beeldkrant`, the systemd service and the `update` command, and prints the admin address and the one-time password at the end. Running it again on an installed machine runs `update`.

Settings: `PORT=<port>` changes the panel port, `BEELDKRANT_REF=<branch>` installs another branch, and `GPU=intel`, `GPU=amd` or `GPU=none` chooses the VAAPI drivers for hardware encoding (by default the installer looks for a GPU passed through to the machine). NVIDIA is only supported in the LXC container for now.

By hand, without the installer:

```bash
apt install -y git ffmpeg chromium xvfb pulseaudio fonts-dejavu fonts-noto-color-emoji nodejs npm
git clone https://github.com/rhisijmuiden/TV-Channel-Generator /opt/beeldkrant
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
| `BK_DISPLAY` | `:99` | First virtual X display; each extra playout on air uses the next number |
| `BK_FANOUT_PORT` | `29000` | First local UDP port for the stream fan-out (uses this port and up) |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | GPU device for VAAPI |
| `MAX_UPLOAD_MB` | `2048` | Upload size limit |
| `BK_INITIAL_PASSWORD` | random | One-time admin password on first start |
| `BK_BASE_PATH` | none | Serve everything under this path, e.g. `/channel1` (see below) |
| `BK_SERVICE_TOKEN` | none | Bearer token that is an admin on `/api` (at least 32 characters) |
| `BK_PUBLIC_URL` | none | Public address including the base path, used for the Microsoft sign-in redirect |
| `BK_TRUSTED_PROXIES` | none | Comma-separated IPs or CIDRs of the reverse proxy |

## Running as part of Build My TV Station

[Build My TV Station](https://github.com/rhisijmuiden/BulldMyTVStation) can run Beeldkrant as one part of a station, behind its own reverse proxy. For that Beeldkrant follows the [station contract (version 1)](https://github.com/rhisijmuiden/BulldMyTVStation/blob/main/docs/station-contract.md). None of it is on until it is set, so a standalone install works as before.

- `GET /healthz` answers without a login with `{"status":"ok","app":"beeldkrant","version":…,"contract":1}`, at the root and under the base path.
- `beeldkrant-station [--reset-admin]` (installed by both installers and by `update`) takes `STATION_SERVICE_TOKEN`, `STATION_BASE_PATH`, `STATION_PUBLIC_URL` and `STATION_TRUSTED_PROXIES` from its environment and stores them as the `BK_…` variables above in `/etc/default/beeldkrant` (a variable that is not set stays as it is, an empty one is cleared). It restarts Beeldkrant when something changed, waits for `/healthz`, writes `/var/lib/beeldkrant/station.json` and prints the same JSON; with `--reset-admin` it also gives the user `admin` a new one-time password and adds it as `initialPassword`.
- With a base path the admin panel, the player, the API, the media, redirects and the session cookie all live under it, and the proxy forwards the full path unchanged (`location /channel1/ { proxy_pass http://10.0.0.21:8080; }`).
- With the service token, `Authorization: Bearer <token>` is an admin on the API without a cookie; a wrong token gets 401.
- With trusted proxies set, `X-Forwarded-For`, `-Proto` and `-Host` are only believed from them. Either way, a request with `X-Forwarded-For` never counts as coming from the machine itself, so a proxy on the same host does not open the player data to everyone.

## Repository layout

```
ct/beeldkrant.sh               Proxmox host script (creates the LXC)
install/beeldkrant-install.sh  Runs inside the container
install/debian.sh              Installer for a Debian 13 machine or VM
deploy/                        systemd units for Beeldkrant and for updates started from the panel
scripts/update.sh              The `update` command inside the container
scripts/station.sh             The `beeldkrant-station` command (Build My TV Station)
server/                        Node.js server: API, auth, schedule, feeds, stream pipelines, outputs, IP cameras
test/                          Tests (`npm test`)
docs/screenshots/              Screenshots used in this README
public/admin/                  Admin panel (plain JS, no build step)
public/player/                 Player page and the shared scene renderer
```

## Notes

- The installer downloads from this repository, so the repository must be public (or point `COMMUNITY_SCRIPTS_URL` and `BEELDKRANT_REPO` at a reachable copy).
- Weather comes from [Open-Meteo](https://open-meteo.com) and needs internet access from the container; RSS feeds and audio streams too.
- Some websites refuse to be shown inside another page, so not every URL works as a web page element.

## License

MIT
