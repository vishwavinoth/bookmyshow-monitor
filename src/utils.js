/**
 * utils.js
 * Configuration loading, snapshot diffing and WhatsApp message formatting.
 * No state lives here — everything is pure helpers.
 */

/* ── Configuration ──────────────────────────────────────────────────── */

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() !== 'false';
}

/**
 * Parse a comma-separated recipient list. Plain numbers are stripped to
 * digits ("+91 98765-43210" -> "919876543210"); entries containing "@"
 * (e.g. a group id like "1234567890@g.us") are passed through untouched.
 */
function parseRecipients(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => (entry.includes('@') ? entry : entry.replace(/\D/g, '')))
    .filter(Boolean);
}

const config = {
  port: toInt(process.env.PORT, 3000),
  // Gap between scans. Floored at 2s — below that you gain nothing but
  // dramatically raise the odds of being bot-blocked.
  checkInterval: Math.max(toInt(process.env.CHECK_INTERVAL, 10000), 2000),
  targetUrl:
    process.env.TARGET_URL ||
    'https://in.bookmyshow.com/movies/bengaluru/jana-nayagan/buytickets/ET00430817/20260723',
  // One or many recipients; WHATSAPP_NUMBER kept for backward compatibility.
  whatsappNumbers: parseRecipients(process.env.WHATSAPP_NUMBERS || process.env.WHATSAPP_NUMBER),
  headless: toBool(process.env.HEADLESS, true),
  movieName: process.env.MOVIE_NAME || '',
  maxRetries: toInt(process.env.MAX_RETRIES, 3),
  retryBaseDelay: toInt(process.env.RETRY_BASE_DELAY, 5000),
  navTimeout: toInt(process.env.NAV_TIMEOUT, 60000),
};

/* ── Small helpers ──────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Best-effort movie name from a BMS URL: .../movies/<city>/<slug>/buytickets/... */
function movieNameFromUrl(url) {
  const m = String(url).match(/\/movies\/[^/]+\/([^/]+)\//);
  if (!m) return 'Unknown Movie';
  return m[1]
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ── Snapshot diffing ───────────────────────────────────────────────── */
/*
 * Snapshot shape:
 * {
 *   scannedAt: ISO string,
 *   movie: string,
 *   theatreCount: number,
 *   showCount: number,
 *   theatres: [{ name, shows: [{ time, language, format, status, bookingUrl }] }]
 * }
 *
 * A show's identity is theatre + time + language + format, so the same
 * show is never reported twice and status flips are tracked separately.
 */

function showKey(theatreName, show) {
  return [theatreName, show.time, show.language, show.format].map(normalize).join('|');
}

function indexShows(snapshot) {
  const map = new Map();
  for (const theatre of snapshot.theatres) {
    for (const show of theatre.shows) {
      map.set(showKey(theatre.name, show), { theatre: theatre.name, ...show });
    }
  }
  return map;
}

const BOOKABLE_STATUSES = new Set(['available', 'fast filling', 'almost full']);

const isBookable = (status) => BOOKABLE_STATUSES.has(normalize(status));

/**
 * Compare two snapshots and report what changed.
 * - newTheatres:     theatre names present now but not before
 * - newShows:        shows (theatre+time+language+format) never seen before
 * - becameAvailable: existing shows whose status flipped from unbookable to bookable
 * - otherChanges:    any other status change (e.g. Available -> Sold Out), logged but not alerted
 */
function diffSnapshots(prev, next) {
  const prevShows = indexShows(prev);
  const prevTheatreNames = new Set(prev.theatres.map((t) => normalize(t.name)));

  const newTheatres = [];
  const newShows = [];
  const becameAvailable = [];
  const otherChanges = [];

  for (const theatre of next.theatres) {
    if (!prevTheatreNames.has(normalize(theatre.name))) newTheatres.push(theatre.name);
  }

  for (const [key, show] of indexShows(next)) {
    const before = prevShows.get(key);
    if (!before) {
      newShows.push(show);
      continue;
    }
    if (normalize(before.status) !== normalize(show.status)) {
      if (!isBookable(before.status) && isBookable(show.status)) {
        becameAvailable.push({ ...show, previousStatus: before.status });
      } else {
        otherChanges.push({ ...show, previousStatus: before.status });
      }
    }
  }

  return { newTheatres, newShows, becameAvailable, otherChanges };
}

/* ── WhatsApp message formatting ────────────────────────────────────── */

const DIVIDER = '━━━━━━━━━━━━━━━';
const MAX_MESSAGE_LENGTH = 3500; // stay well under WhatsApp limits

/**
 * Build one or more WhatsApp messages for a list of alert items.
 * Items found in a single scan are combined; the list is split into
 * multiple messages only when it would get uncomfortably long.
 * Each item: { theatre, time, language, format, status, bookingUrl, note? }
 */
function formatAlertMessages(movie, items) {
  const header = `🚨 *BookMyShow Alert*\n\n*Movie:* ${movie}\n_${items.length} new update(s) detected_`;

  const blocks = items.map((item) =>
    [
      `*Theatre:*\n${item.theatre}`,
      `*Time:*\n${item.time}`,
      `*Language:*\n${item.language}`,
      `*Format:*\n${item.format}`,
      `*Status:*\n${item.status}${item.note ? ` (${item.note})` : ''}`,
      `*Booking:*\n${item.bookingUrl || config.targetUrl}`,
    ].join('\n\n')
  );

  const messages = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${DIVIDER}\n\n${block}`;
    if (candidate.length > MAX_MESSAGE_LENGTH && current !== header) {
      messages.push(current);
      current = `${header}\n\n${DIVIDER}\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

module.exports = {
  config,
  sleep,
  normalize,
  movieNameFromUrl,
  showKey,
  isBookable,
  diffSnapshots,
  formatAlertMessages,
};
