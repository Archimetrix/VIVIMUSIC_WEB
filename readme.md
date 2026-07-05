<div align="center">

<img src="icons/icon128.png" alt="Vivimusic Web" width="96" height="96" />

# Vivimusic Web

**Apple Music–style Canvas artwork, synced lyrics, Last.fm scrobbling, and a full visual overhaul for YouTube Music.**

![Manifest](https://img.shields.io/badge/Manifest-V3-5b6cf5?style=flat-square)
![Version](https://img.shields.io/badge/version-2.1-5b6cf5?style=flat-square)
![Browser](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Brave-supported-5b6cf5?style=flat-square)

</div>

---

Vivimusic Web is a browser extension that reskins **[music.youtube.com](https://music.youtube.com)** with animated Canvas-style backgrounds (like Apple Music/Spotify Canvas), word-synced lyrics, Last.fm scrobbling, and a dark, glassy theme — without needing a separate desktop app or a Chrome Web Store install.

This extension is **not published on the Chrome Web Store**. It's distributed as source from this repository and loaded manually as an "unpacked" extension. Follow the installation guide below — it takes about a minute.

---

## Table of Contents

- [Features](#features)
- [Installation Guide](#installation-guide)
  - [Chrome / Brave / Vivaldi / Opera](#chrome--brave--vivaldi--opera)
  - [Microsoft Edge](#microsoft-edge)
  - [Firefox](#firefox)
- [Updating](#updating)
- [Settings](#settings)
- [Last.fm Scrobbling](#lastfm-scrobbling)
- [Permissions & Privacy](#permissions--privacy)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)
- [License](#license)

---

## Features

- 🎨 **Canvas Artwork** — Fetches animated, Apple Music–style Canvas videos (or high-res artwork as a fallback) for the currently playing song and blends it into the player thumbnail and page background.
- 🎤 **Synced Lyrics** — Word-synced lyrics when available, falling back to line-synced, then plain lyrics. Pulled from multiple providers so you almost always get *something*.
- 🔀 **Multiple Lyrics Providers** — Toggle individual sources on or off:
  - BetterLyrics (word-sync / TTML)
  - BetterLyrics (Kugou)
  - BetterLyrics (Legacy)
  - LRCLIB
- 📑 **Auto-open Lyrics Tab** — Optionally jumps straight to the Lyrics tab when a track starts.
- 🎧 **Last.fm Scrobbling** — Logs in with your Last.fm username and password (no browser redirect needed) and scrobbles what you listen to, sends Now Playing status, and syncs Likes/Unlikes as Loves/Unloves on Last.fm.
- 💾 **Local Artwork Cache** — Previously fetched artwork/Canvas videos are cached locally so repeat plays load instantly. Viewable and clearable from the popup.
- 🔔 **Update Checker** — Since this isn't on the Web Store, the popup can check this GitHub repo's [Releases](../../releases) page and let you know when a newer version is out see updating — it notifies you, it does not auto-install).

---

## Installation Guide

> Because this extension isn't listed on any extension store, your browser will warn you that it's an "unpacked" / "developer mode" extension. That's expected and normal — it just means you installed it from source instead of a store.

### Chrome / Brave / Vivaldi / Opera

1. **Download The Zipfile From Releases**
2. **Extract it** to a folder you won't move or delete later (e.g. `Documents/Vivimusic Web`). Chrome loads the extension directly from this folder, so if you delete it, the extension breaks.
3. Open your browser and go to:
   ```
   chrome://extensions
   ```
   (For Brave: `brave://extensions` · For Vivaldi: `vivaldi://extensions` · For Opera: `opera://extensions`)
4. Turn on **Developer mode** — the toggle is in the top-right corner of the extensions page.
5. Click **Load unpacked**.
6. Select the folder you extracted and open the folder you will see icon and src folder when you see these two folders dont click on them just click open to select (the one that directly contains `manifest.json`).
7. Vivimusic Web should now appear in your extensions list and in your toolbar. Open **[music.youtube.com](https://music.youtube.com)**, play a song, and you should see the new theme and Canvas artwork kick in within a second or two.

### Microsoft Edge

Same as above, using `edge://extensions` instead of `chrome://extensions`. Edge calls the same feature **Developer mode**, in the left sidebar.

### Firefox

This extension is built for Manifest V3 (Chromium-based browsers) and is **not currently packaged for Firefox**. Loading it as a temporary add-on via `about:debugging` may partially work, but some features (like the background service worker) are not guaranteed to behave the same way. Chromium-based browsers are recommended.

---

## Updating

 To update Vivimusic Web:

1. Open the extension popup — if a newer version is available, you'll see an **"Update available"** notice (checked automatically twice a day, or manually via **Check for updates** in the popup).
2. Download the latest release from the [Releases page](../../releases) (or pull the latest `main` branch).
3. Extract it and again load unpack it then it will be updated .
That's it — no need to remove and re-add the extension.

---

## Settings

All settings live in the extension popup (click the Vivimusic icon in your toolbar):

| Setting | What it does |
|---|---|
| **Enable Canvas** | Turns the animated artwork/background feature on or off. |
| **Synced Lyrics** | Turns the custom lyrics panel on or off. |
| **Auto-open Lyrics tab** | Automatically switches to the Lyrics tab when a new track starts. |
| **Lyrics providers** | Toggle individual lyrics sources on/off, in priority order. |
| **THEME** | Toggles the full visual reskin independently of Canvas/Lyrics. |
| **Last.fm scrobbling** | Turns Last.fm integration on or off entirely. |
| **Send Now Playing** | Sends a "Now Playing" update to Last.fm as soon as a track starts. |
| **Send Likes/Unlikes** | Mirrors the YouTube Music like button to Last.fm Love/Unlove. |
| **Min. song length (sec)** | Tracks shorter than this are never scrobbled. |
| **Scrobble delay (%)** | Scrobble once this percentage of the track has played. |
| **Scrobble delay (min)** | Or once this many minutes have played — whichever threshold is reached first. |
| **Artwork Cache** | Shows how many songs are cached locally, with a one-click **Clear all**. |
| **Check for updates** | Manually checks this repo's latest release against your installed version. |

---

## Last.fm Scrobbling

Vivimusic Web can scrobble what you listen to on YouTube Music straight to your Last.fm profile.

**Logging in:**
1. Open the popup and switch on **Last.fm scrobbling**.
2. Enter your Last.fm **username** and **password** and click **Connect Last.fm account**.
3. Your password is sent once, directly to Last.fm's own API, and is never stored — only the session token Last.fm returns is saved locally, and it can be revoked any time from your Last.fm account's **Applications** settings without changing your password.

**How scrobble timing works:**
A track is scrobbled once it has played past *whichever comes first*:
- the configured **percentage** of its total duration, or
- the configured **number of minutes**,

as long as the track is longer than the configured **minimum song length**. These three thresholds are all adjustable in the popup.

**Likes/Unlikes:**
When enabled, liking or unliking a song in YouTube Music sends a matching Love/Unlove to Last.fm.

---

## Permissions & Privacy

Vivimusic Web only requests what it needs to function, and only runs on `music.youtube.com`:

| Permission | Why it's needed |
|---|---|
| `storage`, `unlimitedStorage` | Saves your settings and caches artwork locally, in your browser only. |
| `activeTab`, `tabs` | Detects the current track and communicates between the popup and the YouTube Music tab. |
| `alarms` | Schedules the twice-daily background check for new releases on GitHub. |
| Host access to `music.youtube.com` | Where the extension actually runs and injects its UI. |
| Host access to `artwork.boidu.dev`, `lyrics-api.boidu.dev`, `lrclib.net` | Third-party APIs used to fetch Canvas artwork and lyrics for the currently playing song. |
| Host access to `api.github.com` | Used solely to check the latest release tag for the update notice — no data is sent, it's a simple read-only GET request. |
| Host access to `ws.audioscrobbler.com` | Last.fm's API — used only if you enable and log in to Last.fm scrobbling. Sends the current artist/track (and your login once, to establish a session) directly to Last.fm; nothing is sent anywhere else. |

Nothing is sent to any server other than a song/artist lookup (to fetch artwork or lyrics), the anonymous GitHub release check, and — only if you opt in — scrobble data sent to Last.fm's own API. No analytics, no tracking, no third-party accounts beyond Last.fm itself if you choose to connect one.

---

## Troubleshooting

**Nothing changed after installing.**
Make sure you're on `music.youtube.com` (not `youtube.com/music` or the mobile site), and refresh the tab after loading the extension for the first time.

**"Manifest file is missing or unreadable" when loading unpacked.**
You selected the wrong folder — make sure you pick the folder that directly contains `manifest.json`, not its parent folder or the `src` subfolder.

**Extension disappeared / shows an error icon after a browser restart.**
The folder you extracted the extension to was moved, renamed, or deleted. Re-extract it somewhere permanent and reload it via `chrome://extensions`.

**Lyrics aren't showing for a song.**
Not every song has synced lyrics available from any provider. Try toggling different providers on/off in the popup — coverage varies per source.

**Last.fm login fails.**
Double-check your username and password (not your email, unless that's what you normally log in with). If it still fails, your Last.fm account may have two-factor or app-specific restrictions — try generating the connection again after a few minutes.

**Scrobbles aren't showing up on Last.fm.**
Check that **Last.fm scrobbling** is switched on and you're shown as connected in the popup. Remember scrobbles only send after your configured percentage/minutes threshold is reached, not the instant a song starts (that's what "Now Playing" is for).

**Song/Video toggle button doesn't appear, or is in the wrong spot.**
YouTube Music's layout changes occasionally, which can shift where this button gets injected. Open an issue with a screenshot of the player bar.

**Something looks visually broken after a YouTube Music redesign.**
YouTube Music's own layout changes occasionally, which can break selectors this extension relies on. Open an issue on this repository with a screenshot and the URL/page you were on.

---

## Credits

- Built and maintained by **Archimetrix**
- Theme design foundation by **Chengggit**
- Lyrics data via **BetterLyrics** and **[LRCLIB](https://lrclib.net)**
- Scrobbling powered by **[Last.fm](https://www.last.fm)**

---

## License

Copyright (c) 2026 [Archimetrix]. All rights reserved.

This software and associated documentation files (the "Software") are proprietary 
and confidential. No part of this Software may be reproduced, distributed, 
transmitted, transcribed, stored in a retrieval system, or translated into 
any human or computer language, in any form or by any means, without the 
prior written permission of the copyright owner.
