<p align="center">
  <img src="assets/banner.svg" alt="BookMyShow Monitor — instant WhatsApp alerts when new shows, theatres or seats open up" width="100%">
</p>

# BookMyShow Monitor

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js >= 18"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/scraper-Playwright-45ba4b" alt="Playwright"></a>
  <a href="https://wwebjs.dev"><img src="https://img.shields.io/badge/alerts-whatsapp--web.js-25D366" alt="whatsapp-web.js"></a>
</p>

A lightweight, backend-only Node.js service that continuously watches a BookMyShow
"buy tickets" page and sends you a **WhatsApp alert** the moment new theatres,
show timings or booking slots appear.

- **Scraping:** Playwright (headless Chromium, persistent page for ~1-3s scans)
- **Notifications:** whatsapp-web.js with `LocalAuth` (QR scan needed only once)
- **Scheduling:** continuous scan loop — the next scan starts a configurable
  gap after the previous one finishes, so alerts go out within seconds of
  shows appearing
- **Logging:** Winston (console + `logs/` files)
- **Storage:** none — only the latest snapshot is kept in memory

```
bookmyshow-monitor/
├── src/
│   ├── app.js        # entry point: Express server + startup wiring
│   ├── scraper.js    # Playwright scraping of the BMS page
│   ├── monitor.js    # cron scheduling, diffing, retries/backoff
│   ├── whatsapp.js   # whatsapp-web.js client + alert delivery
│   ├── logger.js     # Winston configuration
│   ├── routes.js     # REST API endpoints
│   └── utils.js      # config, snapshot diffing, message formatting
├── logs/             # combined.log / error.log (created automatically)
├── .env.example
├── package.json
└── README.md
```

---

## Requirements

- **Node.js 18+** (latest LTS recommended)
- Windows, macOS or Linux
- A WhatsApp account on your phone (to link the sender device)

## Installation

```bash
cd bookmyshow-monitor
npm install
```

`npm install` also runs `npx playwright install chromium` (via the `postinstall`
script) to download the browser Playwright uses for scraping. whatsapp-web.js
brings its own bundled Chromium through Puppeteer. The first install is
therefore large (a few hundred MB) — that is expected.

## Environment setup

```bash
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

Then edit `.env`:

| Variable           | Default    | Description                                                        |
| ------------------ | ---------- | ------------------------------------------------------------------ |
| `PORT`             | `3000`     | Port for the REST API                                               |
| `CHECK_INTERVAL`   | `10000`    | Gap in **ms** between scans (min 2000). Detection latency ≈ interval + ~3s scan |
| `TARGET_URL`       | (the Jana Nayagan page) | The BookMyShow buy-tickets page to watch               |
| `WHATSAPP_NUMBERS` | —          | Recipients, **comma-separated**, digits only (e.g. `919876543210,918765432109`); group ids (`...@g.us`) allowed. `WHATSAPP_NUMBER` still works |
| `HEADLESS`         | `true`     | Set `false` to watch the scraping browser (useful for debugging)   |
| `MOVIE_NAME`       | scraped    | Optional display name used in alerts                                |
| `MAX_RETRIES`      | `3`        | Scrape retries per scan before the scan is marked failed            |
| `RETRY_BASE_DELAY` | `5000`     | Base delay (ms) for exponential retry backoff                       |
| `NAV_TIMEOUT`      | `60000`    | Playwright navigation timeout (ms)                                  |
| `LOG_LEVEL`        | `info`     | Winston log level                                                   |

## Running the application

```bash
npm start
```

You should see:

1. `Application started — API listening on http://localhost:3000`
2. A **QR code** printed in the terminal (first run only — see below)
3. `Scan started` / `Scan completed: N theatre(s), M show(s) found` every interval

The process runs indefinitely. Stop it with `Ctrl+C` (it shuts down the
browser and WhatsApp session cleanly).

## WhatsApp QR authentication

On the **first run** a QR code is printed in the terminal:

1. Open WhatsApp on your phone
2. **Settings → Linked devices → Link a device**
3. Scan the QR code in the terminal

The session is stored in `.wwebjs_auth/` by `LocalAuth`, so every subsequent
start authenticates automatically — **the QR is needed only once**. If the
session ever breaks (e.g. you unlink the device), delete the `.wwebjs_auth/`
folder and restart to re-pair.

Alerts triggered before the WhatsApp client finishes connecting are queued in
memory and delivered as soon as it is ready.

Every alert is sent to **all** recipients in `WHATSAPP_NUMBERS`. Delivery is
best-effort per recipient — one unreachable number never blocks the others,
and the log records how many recipients each message reached.

To alert a **WhatsApp group** instead of (or alongside) individual numbers,
add the group's id (ends in `@g.us`) to `WHATSAPP_NUMBERS`. The linked account
must be a member of that group.

## How monitoring works

1. Scans run in a **continuous loop**: the next scan starts `CHECK_INTERVAL`
   milliseconds after the previous one finishes. With the default 10 s gap and
   a ~1-3 s scan, a new show is detected — and the WhatsApp alert sent — within
   roughly **5-15 seconds** of BookMyShow publishing it.
2. Playwright reuses one warm Chromium process and opens a **fresh context**
   per scan (re-navigating a single persistent page breaks BookMyShow's SPA
   re-hydration, so this is deliberate), waiting for the dynamic showtime
   content via **content checks — never fixed sleeps**. Extraction then runs
   two strategies:
   1. **Structured state (primary):** BookMyShow ships the complete showtime
      payload in `window.__INITIAL_STATE__`. This covers *all* venues —
      including ones the virtualized venue list hasn't rendered on screen —
      with theatre name, timings, language, format, availability status and
      per-venue booking URLs.
   2. **DOM fallback:** if the state blob ever disappears, showtime pills are
      located by their text and the owning venue is derived from the row's
      text, after scrolling to mount lazy content.
3. Overlapping scans are impossible: the loop is strictly sequential, and a
   manual `POST /scan` that collides with a running scan gets a `409`.

### Failure handling

- Each scan internally retries up to `MAX_RETRIES` times with **exponential
  backoff** (`RETRY_BASE_DELAY × 2^attempt`).
- If entire scans keep failing, the monitor enters a cooldown that doubles
  with every consecutive failure (capped at 10 minutes), then resumes
  automatically. One successful scan resets everything.
- Scraping failures can never crash the process — errors are caught, logged
  and reported via `GET /health`.

## How change detection works

Only the **latest snapshot is kept in memory** (no database, no files):

- A show's identity is the combination `theatre + time + language + format`.
- The **first successful scan after startup becomes the baseline** — nothing
  is alerted for it. After a restart, the next scan is simply the new baseline.
- On every subsequent scan the new snapshot is diffed against the previous one:
  - **New theatres** → alerted (all their shows count as new shows)
  - **New show timings** → alerted
  - **Status flips to bookable** (e.g. `Sold Out → Available`) → alerted, with
    the previous status noted
  - Other status changes (e.g. `Available → Sold Out`) → logged only
- Duplicates within a scan are ignored, and unchanged shows are never
  re-alerted.
- All new items found in a single scan are **combined into one WhatsApp
  message** (split only if it would exceed WhatsApp's practical length limit).
- Alerts lead with the **movie poster** (taken from the page's `og:image`
  tag) plus a short caption, followed by the detailed text. If the poster
  can't be fetched, the alert simply arrives text-only.

Example alert:

```
🚨 BookMyShow Alert

Movie: Jana Nayagan
1 new update(s) detected
━━━━━━━━━━━━━━━

Theatre:
PVR Nexus Mall

Time:
7:30 PM

Language:
Tamil

Format:
IMAX

Status:
Available

Booking:
https://in.bookmyshow.com/...
```

## API documentation

| Method | Endpoint      | Description |
| ------ | ------------- | ----------- |
| GET    | `/health`     | Application status, WhatsApp status, monitor state |
| GET    | `/last-scan`  | Timestamp and outcome of the most recent scan |
| GET    | `/shows`      | The latest scraped snapshot currently in memory |
| POST   | `/scan`       | Trigger an immediate scan (waits for completion) |
| POST   | `/test-alert` | Send a sample WhatsApp alert to verify delivery |

```bash
curl http://localhost:3000/health
curl http://localhost:3000/last-scan
curl http://localhost:3000/shows
curl -X POST http://localhost:3000/scan
curl -X POST http://localhost:3000/test-alert
```

`GET /shows` response shape:

```json
{
  "scannedAt": "2026-07-16T09:30:00.000Z",
  "movie": "Jana Nayagan",
  "url": "https://in.bookmyshow.com/movies/bengaluru/jana-nayagan/buytickets/ET00430817/20260723",
  "theatreCount": 2,
  "showCount": 5,
  "theatres": [
    {
      "name": "PVR: Nexus, Koramangala",
      "shows": [
        {
          "time": "7:30 PM",
          "language": "Tamil",
          "format": "IMAX",
          "status": "Available",
          "bookingUrl": "https://in.bookmyshow.com/..."
        }
      ]
    }
  ]
}
```

`POST /scan` returns `409` if a scan is already running.

## Logging

Winston logs to the console and to files:

- `logs/combined.log` — everything (rotated at 5 MB, 5 files)
- `logs/error.log` — errors only (rotated at 5 MB, 3 files)

Logged events include: application start, scan start/completion, theatre and
show counts, new shows detected, WhatsApp messages sent, and all errors.

## Troubleshooting

- **0 theatres found every scan** — bookings for that date may simply not be
  open yet (that is exactly the situation this tool waits for: the moment they
  open, everything is "new" and you get alerted). If you *can* see shows in a
  normal browser but scans find none, BookMyShow has probably changed its page
  internals — adjust `extractFromState()` / `extractFromDom()` in
  [src/scraper.js](src/scraper.js). `GET /shows` includes a `source` field
  (`state` or `dom`) telling you which strategy produced the data.
- **Multiple language/format tabs** — if the movie runs in several
  language/format combinations, BookMyShow loads the default combination
  first; the monitor watches what the page serves for the target URL.
- **Suspected bot-blocking** — the scraper logs a warning when the page looks
  like an access-denied/captcha page. Try `HEADLESS=false` to observe, and use
  a longer `CHECK_INTERVAL`.
- **WhatsApp keeps asking for the QR** — delete `.wwebjs_auth/` and re-pair
  once; make sure the folder is writable and not cleaned by antivirus.
- **Message not delivered** — verify `WHATSAPP_NUMBER` has the country code
  and digits only, and that the number is on WhatsApp.

## Notes & fair use

- Scraping BookMyShow may be against their Terms of Service; keep the polling
  interval reasonable (the default 30 s is already aggressive) and use this
  for personal notifications only.
- whatsapp-web.js is an unofficial library that automates WhatsApp Web.
  WhatsApp does not endorse it and heavy automation can risk the account —
  this app only ever *sends* the occasional alert, which keeps usage light.
