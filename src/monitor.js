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
const { config, sleep, diffSnapshots, formatAlertMessages } = require('./utils');

const MAX_COOLDOWN_MS = 10 * 60 * 1000;

const state = {
  lastSnapshot: null, // latest successful scan (in-memory only)
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
  logger.info(`Monitoring ${config.targetUrl}`);
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

/** Scrape with per-scan retries and exponential backoff. */
async function scrapeWithRetry() {
  let attempt = 0;
  for (;;) {
    try {
      return await scrape();
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
 * Run one full scan: scrape -> diff -> notify -> store snapshot.
 * Never throws; failures are recorded in state and logged.
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
    const snapshot = await scrapeWithRetry();
    const previous = state.lastSnapshot;

    // A sudden empty result right after a healthy one is far more likely a
    // transient page failure (or soft bot-block) than every single show
    // vanishing. Keep the previous snapshot as the baseline — otherwise the
    // shows "coming back" next scan would flood WhatsApp with false alerts.
    if (previous && previous.showCount > 0 && snapshot.showCount === 0) {
      state.lastScanAt = snapshot.scannedAt;
      state.lastScanStatus = 'success';
      state.scanCount += 1;
      logger.warn(
        `Scan returned 0 shows while the previous scan had ${previous.showCount} — treating as transient, keeping previous snapshot`
      );
      return { suspectEmpty: true, theatres: 0, shows: 0 };
    }

    state.lastSnapshot = snapshot;
    state.lastScanAt = snapshot.scannedAt;
    state.lastScanStatus = 'success';
    state.lastError = null;
    state.scanCount += 1;
    state.consecutiveFailures = 0;

    logger.info(
      `Scan completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${snapshot.theatreCount} theatre(s), ${snapshot.showCount} show(s) found`
    );

    if (!previous) {
      logger.info('First scan — stored as baseline, no notifications sent');
      return { baseline: true, theatres: snapshot.theatreCount, shows: snapshot.showCount };
    }

    const diff = diffSnapshots(previous, snapshot);
    const alertItems = [
      ...diff.newShows,
      ...diff.becameAvailable.map((s) => ({ ...s, note: `was ${s.previousStatus}` })),
    ];

    if (diff.newTheatres.length) {
      logger.info(`New theatres detected: ${diff.newTheatres.join(', ')}`);
    }
    for (const change of diff.otherChanges) {
      logger.info(
        `Status change (not alerted): ${change.theatre} ${change.time} — ${change.previousStatus} -> ${change.status}`
      );
    }

    if (alertItems.length) {
      logger.info(`New shows detected: ${alertItems.length} — sending WhatsApp alert`);
      const messages = formatAlertMessages(snapshot.movie, alertItems);
      await whatsapp.sendAlert(messages, {
        imageUrl: snapshot.posterUrl,
        imageCaption: `🚨 *${snapshot.movie}* — ${alertItems.length} new update(s) detected`,
      });
    } else {
      logger.info('No new shows or availability changes detected');
    }

    return {
      baseline: false,
      theatres: snapshot.theatreCount,
      shows: snapshot.showCount,
      newTheatres: diff.newTheatres.length,
      newShows: diff.newShows.length,
      becameAvailable: diff.becameAvailable.length,
    };
  } catch (err) {
    state.lastScanStatus = 'failed';
    state.lastError = err.message;
    state.consecutiveFailures += 1;
    logger.error(`Scan failed (${state.consecutiveFailures} consecutive): ${err.message}`);
    return { failed: true, error: err.message };
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
  };
}

function getSnapshot() {
  return state.lastSnapshot;
}

function isScanning() {
  return state.isScanning;
}

module.exports = { start, stop, performScan, getState, getSnapshot, isScanning };
