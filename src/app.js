/**
 * app.js
 * Entry point: loads config, starts the Express API, connects WhatsApp
 * and kicks off the monitoring loop.
 */
require('dotenv').config();

const express = require('express');
const logger = require('./logger');
const { config } = require('./utils');
const routes = require('./routes');
const monitor = require('./monitor');
const whatsapp = require('./whatsapp');
const { closeBrowser } = require('./scraper');

const app = express();
app.use(express.json());
app.use('/', routes);

// 404 + central error handler
app.use((req, res) => res.status(404).json({ message: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`API error: ${err.message}`);
  res.status(500).json({ message: 'Internal server error' });
});

// Startup failures (e.g. port already in use) must be loud and fatal —
// unlike scraping errors, there is nothing to recover into.
const onServerError = (err) => {
  logger.error(`Failed to start server on port ${config.port}: ${err.message}`);
  process.exit(1);
};

const server = app.listen(config.port, () => {
  logger.info(`Application started — API listening on http://localhost:${config.port}`);

  if (!config.whatsappNumbers.length) {
    logger.warn('WHATSAPP_NUMBERS is not set — alerts will fail until it is configured in .env');
  } else {
    logger.info(`WhatsApp alerts will be sent to ${config.whatsappNumbers.length} recipient(s)`);
  }

  // Connect WhatsApp first (QR on first run); scans start immediately and
  // any alerts raised before WhatsApp is ready are queued, not lost.
  whatsapp.init();
  monitor.start();
});
server.on('error', onServerError);

/* ── Never crash because of scraping failures ───────────────────────── */
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack || err.message}`);
});

/* ── Graceful shutdown ──────────────────────────────────────────────── */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);
  monitor.stop();
  await Promise.allSettled([closeBrowser(), whatsapp.shutdown()]);
  server.close(() => process.exit(0));
  // Force-exit if something hangs (e.g. a browser refusing to close).
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
