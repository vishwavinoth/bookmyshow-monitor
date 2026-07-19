/**
 * monitor.js
 * The heart of the application: runs a continuous scan loop, keeps the
 * latest snapshot in memory, diffs consecutive scans and pushes WhatsApp
 * alerts for anything new.
 *
 * Scheduling: a self-pacing loop, not cron ticks. The next scan starts
 * CHECK_INTERVAL after the previous one *finishes*, so there is no tick
 * alignment, no skipped ticks, and detection latency is simply
 * interval + scan duration (~1-3s with the persistent page).
 *
 * Reliability model:
 * - Each scan retries internally with exponential backoff
 *   (RETRY_BASE_DELAY * 2^attempt) up to MAX_RETRIES times.
 * - If whole scans keep failing, the loop's gap grows exponentially
 *   (capped at 10 minutes) so a broken page/network never causes a hot
 *   failure loop. One success resets everything.
 * - Scans never overlap: the loop is sequential, and a manual POST /scan
 *   that collides with a running scan is rejected by the isScanning guard.
 * - No persistence: the first successful scan after startup becomes the
 *   baseline and is never alerted on.
 */
const logger = require('./logger');
const { scrape } = require('./scraper');
const whatsapp = require('./whatsapp');
const {
  config,
  sleep,
  diffSnapshots,
  formatAlertMessages,
  cityFromUrl,
  parseTimeToMinutes,
} = require('./utils');

const MAX_COOLDOWN_MS = 10 * 60 * 1000;

const state = {
  snapshots: new Map(), // targetUrl -> latest successful snapshot (in-memory only)
  lastScanAt: null,
  lastScanStatus: 'idle', // idle | success | failed
  lastError: null,
  scanCount: 0,
  isScanning: false,
  consecutiveFailures: 0,
};

let running = false;

/* ── Scheduling ─────────────────────────────────────────────────────── */

function start() {
  for (const url of config.targetUrls) logger.info(`Monitoring ${url}`);
  if (config.earlyShowsOnly) {
    const h = Math.floor(config.earlyShowCutoff / 60);
    const m = String(config.earlyShowCutoff % 60).padStart(2, '0');
    logger.info(
      `Alert filter active: only *Available* shows starting before ${h}:${m} (24h) trigger alerts`
    );
  }
  logger.info(
    `Continuous scan loop: next scan starts ${config.checkInterval}ms after the previous one finishes`
  );
  running = true;
  loop().catch((err) => logger.error(`Scan loop crashed unexpectedly: ${err.message}`));
}

async function loop() {
  while (running) {
    await performScan('scheduled');
    if (!running) break;

    let delay = config.checkInterval;
    if (state.consecutiveFailures > 0) {
      delay = Math.min(config.checkInterval * 2 ** state.consecutiveFailures, MAX_COOLDOWN_MS);
      logger.warn(
        `Backing off after ${state.consecutiveFailures} consecutive failed scan(s) — next attempt in ${Math.round(delay / 1000)}s`
      );
    }
    await sleep(delay);
  }
}

function stop() {
  running = false;
}

/* ── Scanning ───────────────────────────────────────────────────────── */

/** Scrape one target with per-scan retries and exponential backoff. */
async function scrapeWithRetry(targetUrl) {
  let attempt = 0;
  for (;;) {
    try {
      return await scrape(targetUrl);
    } catch (err) {
      attempt += 1;
      if (attempt > config.maxRetries) throw err;
      const delay = config.retryBaseDelay * 2 ** (attempt - 1);
      logger.warn(
        `Scrape attempt ${attempt}/${config.maxRetries} failed (${err.message}) — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}

/**
 * The alert filter: only shows that are genuinely bookable *right now*
 * ("Available" — not Sold Out, Fast Filling, Almost Full or Not Available)
 * and, when EARLY_SHOWS_ONLY is set, only early/FDFS shows starting before
 * the cutoff. Unparseable times fail open so an odd format never hides a
 * potential FDFS alert.
 */
function passesAlertFilter(show) {
  if (String(show.status).toLowerCase() !== 'available') return false;
  if (config.earlyShowsOnly) {
    const minutes = parseTimeToMinutes(show.time, null);
    if (minutes !== null && minutes >= config.earlyShowCutoff) return false;
  }
  return true;
}

/** Scan a single target URL; returns { snapshot?, alertItems, summary }. */
async function scanTarget(targetUrl) {
  const snapshot = await scrapeWithRetry(targetUrl);
  const previous = state.snapshots.get(targetUrl);
  const label = snapshot.city || cityFromUrl(targetUrl) || targetUrl;

  // A sudden empty result right after a healthy one is far more likely a
  // transient page failure (or soft bot-block) than every single show
  // vanishing. Keep the previous snapshot as the baseline — otherwise the
  // shows "coming back" next scan would flood WhatsApp with false alerts.
  if (previous && previous.showCount > 0 && snapshot.showCount === 0) {
    logger.warn(
      `[${label}] returned 0 shows while the previous scan had ${previous.showCount} — treating as transient, keeping previous snapshot`
    );
    return { alertItems: [], summary: { url: targetUrl, suspectEmpty: true } };
  }

  state.snapshots.set(targetUrl, snapshot);
  logger.info(`[${label}] ${snapshot.theatreCount} theatre(s), ${snapshot.showCount} show(s)`);

  if (!previous) {
    logger.info(`[${label}] first scan — stored as baseline, no notifications sent`);
    return {
      snapshot,
      alertItems: [],
      summary: { url: targetUrl, baseline: true, theatres: snapshot.theatreCount, shows: snapshot.showCount },
    };
  }

  const diff = diffSnapshots(previous, snapshot);
  const candidates = [
    ...diff.newShows,
    ...diff.becameAvailable.map((s) => ({ ...s, note: `was ${s.previousStatus}` })),
  ];
  const kept = candidates.filter(passesAlertFilter);
  const filteredOut = candidates.length - kept.length;

  if (diff.newTheatres.length) {
    logger.info(`[${label}] new theatres detected: ${diff.newTheatres.join(', ')}`);
  }
  for (const change of diff.otherChanges) {
    logger.info(
      `[${label}] status change (not alerted): ${change.theatre} ${change.time} — ${change.previousStatus} -> ${change.status}`
    );
  }
  if (filteredOut > 0) {
    logger.info(
      `[${label}] ${filteredOut} change(s) suppressed by the alert filter (not Available, or after the early-show cutoff)`
    );
  }

  return {
    snapshot,
    alertItems: kept.map((item) => ({ ...item, city: snapshot.city, pageUrl: snapshot.url })),
    summary: {
      url: targetUrl,
      theatres: snapshot.theatreCount,
      shows: snapshot.showCount,
      newTheatres: diff.newTheatres.length,
      newShows: diff.newShows.length,
      becameAvailable: diff.becameAvailable.length,
      alerted: kept.length,
    },
  };
}

/**
 * Run one full scan cycle over every target page:
 * scrape -> diff -> filter -> combine -> notify.
 * Never throws; failures are recorded in state and logged. One page
 * failing never stops the others from being scanned.
 */
async function performScan(trigger = 'scheduled') {
  if (state.isScanning) {
    logger.warn('Previous scan still running — skipping this tick');
    return { skipped: true, reason: 'scan already in progress' };
  }

  state.isScanning = true;
  const startedAt = Date.now();
  logger.info(`Scan started (trigger: ${trigger})`);

  try {
    const results = [];
    const alertItems = [];
    let successes = 0;
    let lastError = null;
    let movie = config.movieName;

    for (const url of config.targetUrls) {
      try {
        const { snapshot, alertItems: items, summary } = await scanTarget(url);
        successes += 1;
        results.push(summary);
        alertItems.push(...items);
        if (snapshot && !movie) movie = snapshot.movie;
      } catch (err) {
        lastError = err;
        results.push({ url, failed: true, error: err.message });
        logger.error(`[${cityFromUrl(url) || url}] scan failed: ${err.message}`);
      }
    }

    const totals = [...state.snapshots.values()].reduce(
      (acc, s) => ({ theatres: acc.theatres + s.theatreCount, shows: acc.shows + s.showCount }),
      { theatres: 0, shows: 0 }
    );
    logger.info(
      `Scan completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${totals.theatres} theatre(s), ${totals.shows} show(s) across ${successes}/${config.targetUrls.length} page(s)`
    );

    if (successes > 0) {
      state.lastScanAt = new Date().toISOString();
      state.lastScanStatus = 'success';
      state.lastError = lastError ? lastError.message : null;
      state.scanCount += 1;
      state.consecutiveFailures = 0;
    } else {
      state.lastScanStatus = 'failed';
      state.lastError = lastError ? lastError.message : 'all targets failed';
      state.consecutiveFailures += 1;
      logger.error(`Scan failed (${state.consecutiveFailures} consecutive): ${state.lastError}`);
      return { failed: true, error: state.lastError, results };
    }

    if (alertItems.length) {
      logger.info(`New shows detected: ${alertItems.length} — sending WhatsApp alert`);
      const messages = formatAlertMessages(movie || 'BookMyShow', alertItems);
      await whatsapp.sendAlert(messages);
    } else {
      logger.info('No alert-worthy new shows detected');
    }

    return { alerted: alertItems.length, results };
  } finally {
    state.isScanning = false;
  }
}

/* ── State accessors for the REST API ───────────────────────────────── */

function getState() {
  return {
    lastScanAt: state.lastScanAt,
    lastScanStatus: state.lastScanStatus,
    lastError: state.lastError,
    scanCount: state.scanCount,
    isScanning: state.isScanning,
    consecutiveFailures: state.consecutiveFailures,
    targets: config.targetUrls.length,
  };
}

/** All per-target snapshots, or null when nothing has been scanned yet. */
function getSnapshot() {
  if (!state.snapshots.size) return null;
  const targets = [...state.snapshots.values()];
  return {
    scannedAt: state.lastScanAt,
    targetCount: targets.length,
    theatreCount: targets.reduce((n, s) => n + s.theatreCount, 0),
    showCount: targets.reduce((n, s) => n + s.showCount, 0),
    targets,
  };
}

function isScanning() {
  return state.isScanning;
}

module.exports = { start, stop, performScan, getState, getSnapshot, isScanning };
