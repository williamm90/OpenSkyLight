# Tablet Family Hub — Design

**Date:** 2026-11-06
**Branch:** `tablet-web` on the `williamm90/OpenSkyLight` fork

## Intent

Turn OpenSkyLight into a family hub that lives on a **large Samsung Android
tablet** mounted on the wall. Kids should be able to walk up and see the day,
tick off chores, fill a sticker card, look at family photos and the cameras,
and call mom, dad or grandparents with one tap.

## Decisions (from the owner)

| Area | Decision |
|---|---|
| Display | Large Samsung tablet (12–15"), wall-mounted, landscape |
| Calendars | **Google Calendar is primary** (two-way). Apple (iCloud) and Outlook calendars **read-only** via ICS links |
| Chores & rewards | Stay in the app's **own database** (not Google) |
| Rewards | A **sticker card** per kid |
| Calling | **Google Voice**, one-tap buttons with a **photo of each person** |
| Photos | **iCloud shared album** first; Google Photos acceptable later |
| Cameras | Google Home cameras **live on the family screen** (Device Access, $5 once approved); a button opens Google Home for history/events |

## Builder's calls (not explicitly approved — flagged for review)

1. **Architecture: tablet + small always-on server.** The Node backend runs
   headless (`npm run server`, or Docker) on a mini PC / Raspberry Pi / NAS.
   The tablet runs **Fully Kiosk Browser** pointed at the server. Chosen over a
   native Android app because Android kills background sync and almost all of
   the existing code (SQLite, Google sync, ffmpeg) is Node-only.
2. **The Windows Electron app keeps working.** Both entry points share every
   service; only the Electron-specific bits (windows, safeStorage, protocols,
   powerMonitor, auto-updater) are swapped out behind small interfaces.
3. **Display auth = pairing code + HttpOnly cookie.** On first start the server
   prints a 6-digit pairing code; entering it on the tablet sets a long-lived
   `SameSite=Strict` cookie. Cookies (not bearer headers) because `<img>`,
   `EventSource` and camera WebSockets can't send headers. The parental PIN
   still gates settings exactly as before.
4. **Google sign-in on a headless server = paste-back flow.** The display shows
   the Google link; after signing in (best done from a laptop browser opened to
   the server), the browser lands on a dead `127.0.0.1` page — paste that URL
   back and the server finishes the exchange. One-time setup.
5. **Secrets at rest** use Electron `safeStorage` in the desktop app and
   AES-256-GCM with a key file in the data directory on the server.
6. **Calling = `tel:` / Android intent link handed to the Google Voice app.**
   Google Voice has no calling API. Parents choose per-install between a plain
   `tel:` link and an explicit Google Voice intent. Needs on-device testing.
7. **Sticker card reuses the star ledger.** 1 star = 1 sticker. Each kid picks
   a goal reward; the card has `costStars` slots. When it's full the kid taps
   "I did it!", which creates the existing pending redemption for a parent to
   approve, and the card starts over.
8. **iCloud shared album** is read through Apple's public-website endpoint
   (unofficial but long-stable); photos are downloaded into a local cache and
   served like the existing photo folder.
9. **Photo avatars** are resized on the tablet to 256 px and stored in SQLite
   as data URLs (tiny, no file management).

## Goals

- Runs in a browser on an Android tablet, reliably, all day
- Chores, sticker cards, calendars (Google 2-way; Apple/Outlook read-only)
- One-tap Google Voice calling with photo buttons
- Family photos from an iCloud shared album
- Google Home / Nest cameras (phase 5, see open questions)

## Non-goals

- A native Android app
- Two-way Apple/Outlook sync
- Video calling
- Internet-facing hosting (LAN / Tailscale only)

## Anti-goals

- Kids able to reach settings, call arbitrary numbers, or change rewards
- Anything that needs a paid subscription to keep working

## Phases

1. **Web server mode** — headless server, HTTP bridge, pairing, SSE pushes,
   photos & bird images over HTTP, camera WebSocket over the main port,
   client-side screensaver idle, Fully Kiosk screen on/off, Docker.
2. **Family faces & calling** — photo avatars for people, call contacts,
   "Call family" home tile with confirm sheet.
3. **Sticker cards** — goal per kid, card view, celebration on completion.
4. **Photos & calendars** — iCloud shared album sync; accept `webcal://`;
   friendlier "Add Apple / Outlook calendar" copy.
5. **Nest cameras** — via Google Device Access (SDM API, WebRTC). Blocked on
   which camera models the family has.
6. **Setup guide** — tablet, Fully Kiosk, Google Voice, server.

## Status (2026-11-06)

| Phase | State |
|---|---|
| 1. Web server mode | Built and tested (unit + browser end-to-end). Docker image written, not yet test-built |
| 2. Family faces & calling | Built. Google Voice hand-off needs testing on the real tablet |
| 3. Sticker cards | Built |
| 4. Photos & calendars | Built (iCloud album sync tested with a mocked iCloud; `webcal://` tested) |
| 5. Cameras | Built: live WebRTC tile via Device Access, plus Open Google Home tile. Unit-tested against a mocked Google; browser offer checked against Google's rules. Needs a real camera to confirm |
| 6. Setup guide | `docs/TABLET-SETUP.md` |

## Open questions

- Owner wants cameras embedded on the screen and approved the one-time $5 Device Access fee (2026-11-07).
- Builder's calls: WebRTC cameras only (all current Nest cams); RTSP-only legacy cameras show a More button. Default *Tap to watch* (battery-friendly) with an *Always live* option. Sign-in uses a Web-application OAuth client with Google's documented `https://www.google.com` redirect and paste-back.
- Builder's call: the Cameras tile asks for the parent PIN by default, because Google Home also controls locks and thermostats.
