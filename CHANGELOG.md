# Changelog

All notable changes to Beeldkrant. The admin panel shows this file under the Info button.

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
