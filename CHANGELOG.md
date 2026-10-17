# Changelog

All notable changes to Beeldkrant. The admin panel shows this file under System → Info.

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
