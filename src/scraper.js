/**
 * scraper.js
 * Playwright-based scraper for a BookMyShow "buy tickets" page.
 *
 * The browser is launched once and reused across scans (a fresh context per
 * scan keeps scans isolated while avoiding the cost of relaunching Chromium
 * every 30 seconds). Heavy resources (images/media/fonts) are blocked.
 *
 * Extraction strategies, in order:
 *   1. window.__INITIAL_STATE__ — BookMyShow ships the complete showtime
 *      payload (all venues, times, availability, booking URLs) in a Redux
 *      state blob. This is the most reliable source and is immune to the
 *      ReactVirtualized venue list, which only mounts on-screen rows in
 *      the DOM.
 *   2. DOM fallback — finds showtime-pill text ("7:30 PM") and derives the
 *      venue name from the ancestor row's text. Only sees currently
 *      rendered rows, so it is a degraded fallback, not the primary path.
 * If BookMyShow changes its page internals, start debugging here.
 */
const { chromium } = require('playwright');
const logger = require('./logger');
const { config, movieNameFromUrl } = require('./utils');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BLOCK_MARKERS = /access denied|unusual traffic|verify you are a human|captcha|request blocked/i;

// Third-party trackers/ads slow the page down and are never needed.
const BLOCKED_HOSTS =
  /doubleclick|googlesyndication|google-analytics|googletagmanager|adsystem|facebook\.net|hotjar|clevertap|branch\.io/i;

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  logger.info(`Launching Chromium (headless=${config.headless})`);
  browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  browser.on('disconnected', () => {
    browser = null;
  });
  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

/** Wait for dynamic content using state/selector checks, never a fixed sleep. */
async function waitForContent(target) {
  const timeout = Math.min(config.navTimeout, 30000);
  try {
    await target.waitForFunction(
      () => {
        const st = window.__INITIAL_STATE__;
        if (st && st.showtimesByEvent && st.showtimesByEvent.showDates) return true;
        return /\b(0?[1-9]|1[0-2]):[0-5][0-9]\s*(AM|PM)\b/i.test(document.body.innerText);
      },
      { timeout }
    );
  } catch {
    logger.warn(
      'Timed out waiting for showtime content — bookings may not be open yet, or the page layout changed'
    );
  }
}

/** Scroll to the bottom so lazily-rendered rows mount (DOM fallback only). */
async function autoScroll(page) {
  await page
    .evaluate(async () => {
      await new Promise((resolve) => {
        let scrolled = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 700);
          scrolled += 700;
          if (scrolled >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 5000);
      });
    })
    .catch(() => {});
}

/* ── Extraction (runs inside the browser; must be self-contained) ────── */

/**
 * Strategy 1: read the structured showtime payload from
 * window.__INITIAL_STATE__.showtimesByEvent. Venue cards look like:
 *   { additionalData: { venueCode, venueName }, showtimes: [
 *       { title: "06:05 AM", screenAttr, styleId, additionalData: { availStatus, sessionId } } ],
 *     header: { ...deeply nested... redirectionUrl } }
 * We search for that shape recursively instead of hard-coding widget paths,
 * so minor reshuffles of the widget tree keep working.
 */
function extractFromState() {
  try {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const byEvent = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.showtimesByEvent;
    const showDates = byEvent && byEvent.showDates;
    if (!showDates || !Object.keys(showDates).length) return null;
    const dateCode =
      byEvent.currentDateCode && showDates[byEvent.currentDateCode]
        ? byEvent.currentDateCode
        : Object.keys(showDates)[0];
    const day = showDates[dateCode];
    if (!day || !day.dynamic) return null;

    // Collect every node shaped like a venue card.
    const venueCards = [];
    const seenVenues = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 14) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      const ad = node.additionalData;
      if (Array.isArray(node.showtimes) && ad && (ad.venueName || ad.venueCode)) {
        const id = ad.venueCode || ad.venueName;
        if (!seenVenues.has(id)) {
          seenVenues.add(id);
          venueCards.push(node);
        }
      }
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    };
    visit(day.dynamic, 0);
    if (!venueCards.length) return null;

    // Deep-search a card's header for the venue's buytickets URL.
    const findBookingUrl = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 12) return null;
      if (typeof node.redirectionUrl === 'string' && node.redirectionUrl.includes('/buytickets/')) {
        return node.redirectionUrl;
      }
      if (typeof node.href === 'string' && node.href.includes('/buytickets/')) return node.href;
      for (const key of Object.keys(node)) {
        const found = findBookingUrl(node[key], depth + 1);
        if (found) return found;
      }
      return null;
    };

    // BookMyShow encodes availability in the pill style; availStatus backs it up.
    const statusOf = (styleId, availStatus) => {
      const s = String(styleId || '').toLowerCase();
      if (s.includes('green')) return 'Available';
      if (s.includes('orange') || s.includes('yellow')) return 'Fast Filling';
      if (s.includes('red')) return 'Almost Full';
      if (s.includes('down') || s.includes('grey') || s.includes('gray') || s.includes('disabled')) {
        return 'Sold Out';
      }
      return String(availStatus) === '0' ? 'Not Available' : 'Available';
    };

    /* Page-level movie / language / dimension */
    let movie = null;
    let language = null;
    let dimension = null;

    const h1 = document.querySelector('h1');
    if (h1) {
      const text = clean(h1.textContent);
      const m = text.match(/^(.+?)\s*[-–—]?\s*\(([^)]+)\)$/); // "Jana Nayagan - (Tamil)"
      if (m) {
        movie = clean(m[1]);
        language = clean(m[2]);
      } else {
        movie = text;
      }
    }
    const analytics = (day.meta && day.meta.analytics) || {};
    for (const [key, value] of Object.entries(analytics)) {
      if (typeof value !== 'string' || !value) continue;
      if (!language && /language/i.test(key)) language = value;
      if (!dimension && /dimension|format/i.test(key)) dimension = value;
    }
    if (!dimension) {
      // The active filter chip reads like "Tamil • 2D".
      const chip = clean(document.body.innerText).match(/([A-Za-z]+)\s*•\s*([A-Za-z0-9 ]{2,12})/);
      if (chip) {
        if (!language) language = chip[1];
        dimension = clean(chip[2]);
      }
    }

    const venues = venueCards
      .map((card) => ({
        name: clean(card.additionalData.venueName) || card.additionalData.venueCode,
        bookingUrl: findBookingUrl(card.header, 0),
        shows: card.showtimes
          .map((s) => ({
            time: clean(s.title).toUpperCase(),
            status: statusOf(s.styleId, s.additionalData && s.additionalData.availStatus),
            formatHint: clean(s.screenAttr) || null,
            bookingUrl: null, // per-show deep links are not exposed; venue URL is used
          }))
          .filter((s) => /\d{1,2}:\d{2}\s*(AM|PM)/i.test(s.time)),
      }))
      .filter((v) => v.name && v.shows.length);

    return {
      source: 'state',
      movie,
      pageLanguage: language,
      pageFormat: dimension,
      venues,
      title: document.title,
      bodySnippet: clean(document.body.innerText).slice(0, 400),
    };
  } catch (err) {
    return null;
  }
}

/**
 * Strategy 2 (fallback): extract from the rendered DOM. The venue list is
 * virtualized, so this only sees rows currently mounted — still enough to
 * detect "bookings just opened" if the state blob ever disappears.
 */
function extractFromDom() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const TIME_RE = /^(0?\d|1[0-2]):[0-5][0-9]\s*(AM|PM)$/i;
  const TIME_ANYWHERE_RE = /(0?\d|1[0-2]):[0-5][0-9]\s*(AM|PM)/i;
  const FORMAT_RE =
    /\b(2D|3D|4DX|IMAX|MX4D|ICE|EPIQ|SCREENX|SCREEN X|DOLBY(?: CINEMA| ATMOS)?|4K|PXL|LASER|ONYX)\b/i;

  const toAbs = (href) => {
    try {
      return href ? new URL(href, location.href).href : null;
    } catch {
      return null;
    }
  };

  const statusFromPill = (el) => {
    const meta = [
      el.className || '',
      el.getAttribute('data-availability') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ]
      .join(' ')
      .toLowerCase();
    if (meta.includes('sold')) return 'Sold Out';
    if (meta.includes('fast') || meta.includes('orange') || meta.includes('yellow')) return 'Fast Filling';
    if (meta.includes('almost') || meta.includes('red')) return 'Almost Full';
    if (el.disabled || meta.includes('lapsed') || meta.includes('inactive') || meta.includes('down')) {
      return 'Not Available';
    }
    return 'Available';
  };

  /* Page-level hints */
  let movie = null;
  let pageLanguage = null;
  let pageFormat = null;
  const h1 = document.querySelector('h1');
  if (h1) {
    const text = clean(h1.textContent);
    const m = text.match(/^(.+?)\s*[-–—]?\s*\(([^)]+)\)$/);
    if (m) {
      movie = clean(m[1]);
      pageLanguage = clean(m[2]);
    } else {
      movie = text;
    }
  }
  const chip = clean(document.body.innerText).match(/([A-Za-z]+)\s*•\s*([A-Za-z0-9 ]{2,12})/);
  if (chip) {
    if (!pageLanguage) pageLanguage = chip[1];
    pageFormat = clean(chip[2]);
  }

  const venues = [];

  /* Legacy markup (kept for older page variants) */
  const legacyNodes = document.querySelectorAll('#venuelist li.list, ul#venuelist > li');
  for (const node of legacyNodes) {
    const nameEl = node.querySelector('.__name, .venue-name, a[href*="/cinemas"]');
    const name = clean(nameEl && nameEl.textContent);
    if (!name) continue;
    const shows = [];
    for (const pill of node.querySelectorAll('a.showtime-pill, a[data-online-url], .body a')) {
      const pillText = clean(pill.textContent);
      const timeMatch = pillText.match(TIME_ANYWHERE_RE);
      if (!timeMatch) continue;
      shows.push({
        time: timeMatch[0].toUpperCase(),
        status: statusFromPill(pill),
        bookingUrl: toAbs(pill.getAttribute('href') || pill.getAttribute('data-online-url')),
        formatHint: (clean(pillText.replace(timeMatch[0], '')).match(FORMAT_RE) || [null])[0],
      });
    }
    if (shows.length) venues.push({ name, bookingUrl: null, shows });
  }

  /* Generic: showtime pills are innermost elements whose text is a time.
     The venue row is the first ancestor whose text has a prefix before the
     first time — that prefix IS the venue name. */
  if (!venues.length) {
    const timeEls = Array.from(document.querySelectorAll('a, button, span, div, li, p')).filter(
      (el) => TIME_RE.test(clean(el.textContent))
    );
    const innermost = timeEls.filter(
      (el) => !timeEls.some((other) => other !== el && el.contains(other))
    );

    const byVenue = new Map();
    for (const el of innermost) {
      const pill = el.closest('a, button, [role="button"]') || el.parentElement || el;

      let name = null;
      let node = pill.parentElement;
      for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
        const text = clean(node.textContent);
        const m = text.match(TIME_ANYWHERE_RE);
        if (m && m.index >= 3) {
          const prefix = clean(text.slice(0, m.index));
          if (prefix.length >= 3 && prefix.length <= 120 && prefix !== movie) name = prefix;
          break; // whether usable or not, higher ancestors only get noisier
        }
      }
      if (!name) continue;

      const anchor = el.closest('a');
      const subLabel = clean(clean(pill.textContent).replace(clean(el.textContent), ''));
      const show = {
        time: clean(el.textContent).toUpperCase(),
        status: statusFromPill(pill),
        bookingUrl: toAbs(anchor && anchor.getAttribute('href')),
        formatHint: (subLabel.match(FORMAT_RE) || [subLabel || null])[0],
      };
      if (!byVenue.has(name)) byVenue.set(name, []);
      byVenue.get(name).push(show);
    }
    for (const [name, shows] of byVenue) venues.push({ name, bookingUrl: null, shows });
  }

  return {
    source: 'dom',
    movie,
    pageLanguage,
    pageFormat,
    venues,
    title: document.title,
    bodySnippet: clean(document.body.innerText).slice(0, 400),
  };
}

/* ── Snapshot assembly (Node side) ──────────────────────────────────── */

/** Convert raw page data into the canonical snapshot shape (deduplicated). */
function buildSnapshot(raw) {
  const movie = config.movieName || raw.movie || movieNameFromUrl(config.targetUrl);

  const theatres = [];
  let showCount = 0;
  for (const venue of raw.venues || []) {
    const seen = new Set();
    const shows = [];
    for (const s of venue.shows || []) {
      // "2D • ONYX LED SCREEN" — page dimension plus the screen attribute,
      // so two same-time shows on different screens stay distinct.
      const format =
        [raw.pageFormat, s.formatHint]
          .filter(Boolean)
          .map((f) => f.toUpperCase())
          .filter((f, i, arr) => arr.indexOf(f) === i)
          .join(' • ') || 'N/A';
      const show = {
        time: s.time.replace(/\s+/g, ' '),
        language: raw.pageLanguage || 'N/A',
        format,
        status: s.status,
        bookingUrl: s.bookingUrl || venue.bookingUrl || null,
      };
      const key = `${show.time}|${show.language}|${show.format}`;
      if (seen.has(key)) continue; // ignore duplicates within a venue
      seen.add(key);
      shows.push(show);
    }
    if (shows.length) {
      theatres.push({ name: venue.name, shows });
      showCount += shows.length;
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    movie,
    url: config.targetUrl,
    source: raw.source || 'unknown',
    theatreCount: theatres.length,
    showCount,
    theatres,
  };
}

/**
 * Scrape the target page once and return a snapshot.
 * Throws on navigation/browser errors (the monitor handles retries);
 * a page with zero venues is a *valid* result (bookings not open yet).
 *
 * Fast path: navigate -> wait for the state blob -> extract. No networkidle
 * wait, no scrolling — a scan typically finishes in ~2-4 seconds. The slower
 * DOM path (idle wait + scroll) only runs if state extraction comes up empty.
 *
 * Each scan gets a fresh context on the reused browser. (Re-navigating one
 * persistent page looks tempting but breaks BookMyShow's SPA re-hydration —
 * repeat visits stop rendering showtimes. Fresh contexts are reliable and
 * nearly as fast because the Chromium process is already warm.)
 */
async function scrape() {
  const instance = await getBrowser();
  const context = await instance.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  try {
    const target = await context.newPage();

    // Skip heavy assets and trackers — we only need the DOM and the state blob.
    await target.route('**/*', (route) => {
      const request = route.request();
      const type = request.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      if (BLOCKED_HOSTS.test(request.url())) return route.abort();
      return route.continue();
    });

    await target.goto(config.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeout,
    });

    await waitForContent(target);

    // Primary: structured state payload (covers ALL venues, even virtualized ones).
    let raw = await target.evaluate(extractFromState);
    if (raw && raw.venues.length) return buildSnapshot(raw);

    // The state can hydrate a beat after domcontentloaded — give straggling
    // XHRs a bounded chance to settle, then try once more.
    await target.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    raw = await target.evaluate(extractFromState);
    if (raw && raw.venues.length) return buildSnapshot(raw);

    // Fallback: rendered DOM.
    await autoScroll(target);
    raw = await target.evaluate(extractFromDom);
    if (raw.venues.length) {
      logger.warn('State extraction found nothing — DOM fallback produced results (layout may have changed)');
    } else if (BLOCK_MARKERS.test(`${raw.title} ${raw.bodySnippet}`)) {
      logger.warn(
        `Page may be bot-blocked (title: "${raw.title}"). Consider HEADLESS=false or a longer CHECK_INTERVAL.`
      );
    }

    return buildSnapshot(raw);
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { scrape, closeBrowser };
