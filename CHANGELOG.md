# Changelog

All notable changes to Beeldkrant. The admin panel shows this file under the Info button.

## 0.9.0 (2026-10-18)

### Added
- Release channels under Info → Software update: **Stable** gets only published releases (GitHub releases with a `vX.Y.Z` tag) and is the default; **Test** gets every change as soon as it is merged. The update check, the update notice, *Update now* and the `update` command all follow the chosen channel. As long as no release has been published, Stable follows the latest changes.
- Switching from Test back to Stable never installs an older version: Beeldkrant stays on its version and moves over with the next stable release.
- Both installers install the newest release by default; the Debian installer takes `BEELDKRANT_CHANNEL=test` to install the latest changes instead. `BEELDKRANT_REF=<branch>` still pins a branch and overrides the channel.

## 0.8.0 (2026-10-17)

### Added
- Build My TV Station support (station contract version 1, all optional): `GET /healthz`, a service token for the API (`BK_SERVICE_TOKEN`, sent as `Authorization: Bearer`), serving everything under a base path (`BK_BASE_PATH`, e.g. `/channel1`), a public address for absolute links (`BK_PUBLIC_URL`) and trusted reverse proxies (`BK_TRUSTED_PROXIES`).
- The `beeldkrant-station` command sets these up, can give the user admin a new one-time password (`--reset-admin`) and writes `/var/lib/beeldkrant/station.json`. Both installers and `update` install it.
- Tests (`npm test`).

### Fixed
- A request that came through a reverse proxy on the same machine (it carries `X-Forwarded-For`) no longer counts as coming from the machine itself, so it cannot read the player data without a login.

## 0.7.1 (2026-10-17)

### Added
- Installer for a Debian 13 machine, VM or VPS (`install/debian.sh`): installs everything without questions, with optional Intel or AMD VAAPI drivers, and prints the admin address and one-time password. Build My TV Station uses it to put Beeldkrant in a virtual machine.

### Changed
- The systemd unit of Beeldkrant now lives in `deploy/beeldkrant.service`, shared by both installers.

## 0.7.0 (2026-10-17)

### Added
- Users and roles under Settings: add, edit, disable and remove users. Three roles: Admin (everything), User (only the parts you switch on: playouts, media, schedule, outputs, application settings, backups) and Read only (can look at everything, change nothing).
- Microsoft Entra SSO under Users and roles → Configure SSO: tenant, app and secret with a configuration test, the redirect URI to copy, sign-in with Microsoft per user, accounts created on first sign-in with a default role, role mapping from Entra app roles, and adding people straight from the Entra directory.
- Security under Settings: require MFA per user (or for everyone or all admins) with an authenticator app, a QR code to set it up and 8 recovery codes; reset a user's MFA. Users can turn MFA on under their account.
- Password policy: minimum length, special characters, upper and lower case and an expiry period. It does not apply to users who sign in with Entra SSO.
- Sign-in is paused for a while after 5 wrong passwords.

### Changed
- Existing editor accounts become User (everything except settings and backups) and viewer accounts become Read only.

## 0.6.0 (2026-10-17)

### Added
- IP cameras under Media management: add RTSP, RTMP, RTMPS and RTP cameras with a user name and password, RTSP over TCP or UDP, "Ignore SSL errors" for RTMPS, and an optional SDP description for RTP.
- Test connection: shows what the camera sends (codec, resolution, frame rate, audio) or a clear reason why it fails (refused, wrong password, unknown path, SSL error, no answer).
- Live preview of each camera with its state, frame rate and log; camera cards show a recent picture.
- IP camera element for scenes: the camera live on air, in any size and position (full screen or picture-in-picture). Cameras of the playout on air stay connected, so a camera scene starts with a picture straight away, and reconnect by themselves when a camera drops.

## 0.5.0 (2026-10-17)

### Added
- Photo carousel element: several photos in one place, one after another, with a time per photo, a transition (fade, slide, zoom or cut) and a fixed or random order. Add photos from the media folders and change the order by dragging or with the arrows.
- Video carousel element: several videos back to back, in a fixed or random order, with or without sound.
- RSS feed element: a whole feed on a scene with photos, titles, text and dates, as a list, a grid or one item at a time, page by page.
- Number of items per RSS feed (default 10), used by RSS elements, RSS scenes and tickers; the feed test shows the items with their photos.
- Upload panel under Media management: upload many files at once and follow each one with its progress, speed and time left, cancel or retry it, and keep working in the panel meanwhile.

### Changed
- The scene editor has a new look: a clear top bar with Scenes, Overlays and Playout settings, buttons with icons, scene thumbnails, a layer list with show/hide and lock, and an "Unsaved changes" marker.
- "Move on: when the media has played" also waits for a full round of a carousel and all pages of an RSS element.

## 0.4.0 (2026-10-17)

### Added
- Several outputs at the same time: RTMP/RTMPS/SRT servers, YouTube and Facebook, each with its own switch, state, bitrate, log and reconnect. The stream is encoded once per playout and copied to every output.
- YouTube and Facebook accounts connected with a code (google.com/device, facebook.com/device): Beeldkrant creates the live broadcast or live video when an output starts and ends it when it stops. Stream keys still work as an alternative.
- Outputs → Routing: choose per output whether it sends the schedule or a fixed playout, in a matrix of playouts and outputs, with an overview of the playouts on air. Each playout on air runs its own renderer and encoder.
- Clone a playout with all its scenes, overlays, ad blocks and music, from the playouts list or the editor, for example to make a clean feed.
- Screenshots of every part of the panel in the README.

### Changed
- An existing stream destination becomes the output "Main stream" after the update.

## 0.3.0 (2026-10-17)

### Added
- Menu in sections: Dashboard (with Statistics), Playouts, Media management, Schedule, Outputs and Settings (Application, Backups), with an Info button at the bottom left.
- Statistics page with load, CPU, memory, outgoing stream and network traffic in Mbit/s and free disk space, with charts of the last 15 minutes.
- Media management overview, Video, Audio and Ads views across all folders, and an Ad marker for files.
- Input streams page for Icecast/Shoutcast streams, with listening, editing and where each stream is used.
- Settings → Application with the server address and web port.
- The update asks to make a local backup of the application and database first, optionally with the media.

### Changed
- Theme and password moved to your account page (click your name at the bottom of the menu).

## 0.2.0 (2026-10-17)

### Added
- **System** menu in the admin panel with **Info** and **Backups**.
- Info shows the version, build, build date and this changelog, and lets you check for a new version by hand. When a new version is available it shows what that version brings.
- Backups of the application, the database and the media (all folders and files), in one archive or in a separate archive per part.
- Scheduled backups on chosen days and a time, and a Back up now button.
- External backup locations: FTP, FTPS and SCP/SFTP, with a connection test and a number of backups to keep.
- Restore a backup from this server or from the external location, choosing which parts to put back. Backups on this server can be downloaded.
- `update` command in the container shell and an update button with a daily check in the admin panel.
- Configurable panel name and a light, dark or automatic theme per user.
- Folders and subfolders in media management, also in the media pickers of the scene editor.

## 0.1.0 (2026-10-16)

### Added
- First release: playouts with a resolution, scenes with text, image, video, ticker, clock, weather, web page and box elements, overlays, transitions, RSS scenes, ad blocks, background music, a weekly schedule and RTMP/SRT output.
- Proxmox VE installer that creates a Debian 13 LXC container.
