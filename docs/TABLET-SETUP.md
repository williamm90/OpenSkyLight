# Wall Tablet Setup

How to run OpenSkyLight on a **large Android tablet** (e.g. a Samsung Galaxy
Tab) mounted on the wall, with a small always-on **home server** doing the
work in the background.

```text
 Home server (mini PC / Raspberry Pi / NAS)          Wall tablet
 ┌───────────────────────────────┐   Wi-Fi   ┌──────────────────────────┐
 │ OpenSkyLight server :8080     │◄─────────►│ Fully Kiosk Browser      │
 │ calendars · chores · photos   │           │ → http://SERVER-IP:8080  │
 └───────────────────────────────┘           │ Google Voice app (calls) │
                                             └──────────────────────────┘
```

## 1. Start the home server

Pick **one** option.

### Option A: Docker (recommended for a mini PC, NAS or Raspberry Pi)

1. Install Docker.
2. In this folder, edit `docker-compose.yml` and set `TZ` to your time zone.
3. Run:

   ```bash
   docker compose up -d
   docker compose logs openskylight   # shows the 6-digit pairing code
   ```

Your data lives in `./data`. Back that folder up.

### Option B: Any Windows or Mac computer that stays on

```bash
npm install
npm run server
```

The server prints the address to open and a **6-digit pairing code**.
Data is stored in `./data` (change it with `OSL_DATA_DIR`; the port with `OSL_PORT`).

> If the tablet can't connect, allow port **8080** through the computer's
> firewall for private networks.

## 2. Set up the tablet

1. **Tablet settings** (Samsung):
   - Battery → **Protect battery** (stops charging at 85%, which keeps an always-plugged-in battery from swelling)
   - Display → Screen timeout: the longest option
   - Turn on Wi-Fi and make sure the tablet is on the same network as the server
2. Install **Fully Kiosk Browser** from the Play Store. A one-time Plus
   license unlocks kiosk mode.
3. In Fully Kiosk → Settings:
   - **Start URL:** `http://SERVER-IP:8080/` (from the server's output)
   - Web Content Settings → **Allow intent: URLs** ON, and **Open URL schemes in other apps** ON (needed for calling)
   - Kiosk Mode → ON (locks kids into the family screen)
   - Device Management → **Keep screen on** ON
   - Optional: Motion Detection → turn the screen on when someone walks up
4. Open the start URL and **type the 6-digit pairing code**. The tablet
   stays paired from then on.

Need to pair another screen later? On a paired screen: Settings → General →
Screens → **Pair a screen**.

## 3. Calendars

- **Google Calendar (two-way):** Settings → Calendars.
  1. Create a free Google Cloud project and enable the **Google Calendar API**.
  2. Set up the OAuth consent screen (External) and add each family Google account as a **test user**.
  3. Create an OAuth client of type **Desktop app**, then paste its ID and secret into OpenSkyLight.
  4. Tap **Connect a Google account**. Opening the link from a **laptop** is easiest.
     After you approve, the laptop lands on a page that says it can't connect.
     That's expected: copy that page's whole address and paste it back into
     OpenSkyLight.
- **Apple / iCloud (view-only):** On a Mac or iPhone, share the calendar as a **Public Calendar** and copy the link. Paste it under *Apple, Outlook & school calendars*. `webcal://` links work.
- **Outlook (view-only):** Outlook on the web → Settings → Calendar → Shared calendars → **Publish a calendar** → copy the **ICS** link.

## 4. Family, chores and sticker cards

1. Settings → **Family**: add each person, with a photo.
2. Settings → **Chores**: add rewards (for example "Ice cream trip" for 8 stars), then chores for each kid.
3. Back in Family, open each kid and pick their **Sticker card goal**.

Each finished chore puts stickers on the kid's card (one per star). When the
card is full, they tap **🎉 I did it!** and a parent approves it in
Settings → Chores. The card then starts over.

## 5. One-tap calling (Google Voice)

1. Install **Google Voice** on the tablet and sign in with the Google account
   whose Voice number you want to call from.
2. Settings → Family → **People to call**: add Grandma, Grandpa, Mom, Dad and
   so on, each with a photo and phone number.
3. Kids tap a photo, then **Call**. Google Voice opens and dials.
4. In Fully Kiosk, allow returning from other apps so the family screen comes
   back when the call ends (Kiosk Mode → *App to run on return*: Fully Kiosk).

If tapping **Call** doesn't open Google Voice: Settings → General → Calling →
**Ask the tablet**. Android will ask which app to use; choose Google Voice →
**Always**.

## 6. Family photos (iCloud shared album)

1. On an iPhone: Photos → Shared Albums → open the album → people icon →
   turn on **Public Website** → **Share Link**.
2. Paste the link into Settings → General → **Family photos**.

New photos added to the album appear on the wall within 30 minutes. They show
as the screensaver and in **Photo** tiles on the home screen.

## 7. Cameras (Google Home)

There are two camera tiles:

| Tile | What it does |
|---|---|
| **Google Home camera** | Live view of one camera right on the family screen. **More ›** opens Google Home for history and events. |
| **Open Google Home** | A big button that opens the Google Home app (or home.google.com). |

### Live cameras: one-time setup (about 20 minutes, $5 once)

Google calls this **Device Access**. Do it from a laptop.

1. Go to the **Device Access Console** (console.nest.google.com/device-access),
   accept the terms and pay the one-time **$5** fee.
2. In **Google Cloud Console** (the same project you use for Google Calendar is fine):
   1. Enable the **Smart Device Management API**.
   2. Credentials → Create credentials → **OAuth client ID** → type **Web application**.
   3. Under *Authorized redirect URIs*, add `https://www.google.com`
   4. Copy the client ID and secret.
   5. On the OAuth consent screen, make sure each family account that owns the cameras is a **test user**.
3. Back in the Device Access Console: **Create project**, paste the OAuth client ID,
   skip events. Copy the **Project ID**.
4. On the family screen: Settings → General → **Cameras** → paste the Project ID,
   client ID and secret → **Save** → **Connect Google Home cameras**.
5. Open the sign-in link (easiest on the laptop), pick your home, **turn on each
   camera**, and allow access. You'll land on google.com: copy that page's whole
   address and paste it back. Done.
6. Home screen → **Edit** → add a **Google Home camera** tile per camera.

Settings → General → Cameras also has:

- **Tap to watch live** (default) or **Always live**. Battery cameras and the
  battery doorbell can't stay live, so leave those on *Tap to watch*. A live view
  lasts about 5 minutes per tap. *Always live* keeps plugged-in cameras running
  while the family screen is showing, and pauses during the screensaver and sleep.
- **Parent PIN first** (default) for leaving the screen to Google Home, because
  Google Home also controls locks and thermostats.
- **Google Home app** or **website** for the **More** button and the Open tile.

Older cameras that only support Google's older RTSP format (Nest Cam IQ, Nest
Hub Max, the original Nest Hello) show a **More** button instead of a live view.

### Leaving and coming back

In Fully Kiosk, allow the Google Home app (Kiosk Mode → app whitelist,
`com.google.android.apps.chromecast.app`) and set *App to run on return* to
Fully Kiosk. Press **Back** to return to the family screen.

## Troubleshooting

| Problem | Fix |
|---|---|
| Tablet shows "Can't reach the home server" | Is the server running? Same Wi-Fi? Firewall allowing port 8080? |
| Pairing code expired | Restart the server for a new one, or use Settings → General → Screens on a paired screen |
| Album says "not found" | Turn on **Public Website** for the shared album |
| Calls don't open Google Voice | Switch Calling to **Ask the tablet** and pick Google Voice → Always |
| Cameras tile does nothing | Install the Google Home app, or switch to **Google Home website** |
| Camera tile says "not connected" | Settings → General → Cameras → connect again |
| Camera shows "unavailable" | The camera may be offline or out of battery. Google also limits how often a live view can start; wait a minute |
| No cameras to pick | In the sign-in step, each camera must be turned on. Run **Connect** again and switch them on |
