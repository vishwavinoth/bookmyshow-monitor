/**
 * routes.js
 * REST API:
 *   GET  /health      — application status
 *   GET  /last-scan   — last scan timestamp + outcome
 *   GET  /shows       — latest in-memory snapshot
 *   POST /scan        — trigger an immediate scan (runs to completion)
 *   POST /test-alert  — send a sample WhatsApp alert to verify delivery
 */
const express = require('express');
const monitor = require('./monitor');
const whatsapp = require('./whatsapp');
const { config, formatAlertMessages } = require('./utils');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    targetUrls: config.targetUrls,
    checkIntervalMs: config.checkInterval,
    alertFilter: {
      availableOnly: true,
      earlyShowsOnly: config.earlyShowsOnly,
      earlyShowCutoffMinutes: config.earlyShowCutoff,
    },
    whatsapp: whatsapp.getStatus(),
    monitor: monitor.getState(),
    timestamp: new Date().toISOString(),
  });
});

router.get('/last-scan', (req, res) => {
  const { lastScanAt, lastScanStatus, lastError, scanCount, isScanning } = monitor.getState();
  res.json({ lastScanAt, lastScanStatus, lastError, scanCount, isScanning });
});

router.get('/shows', (req, res) => {
  const snapshot = monitor.getSnapshot();
  if (!snapshot) {
    return res.status(404).json({ message: 'No scan has completed yet — try again shortly' });
  }
  res.json(snapshot);
});

router.post('/scan', async (req, res, next) => {
  if (monitor.isScanning()) {
    return res.status(409).json({ message: 'A scan is already in progress' });
  }
  try {
    const result = await monitor.performScan('manual');
    res.json({ message: 'Scan completed', result });
  } catch (err) {
    next(err);
  }
});

router.post('/test-alert', async (req, res) => {
  const messages = formatAlertMessages(`${config.movieName || 'Monitor'} — TEST`, [
    {
      theatre: 'Test Theatre (this is only a delivery test)',
      time: new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      }),
      language: 'Tamil',
      format: 'TEST',
      status: 'Working ✅',
      bookingUrl: config.targetUrls[0],
    },
  ]);
  await whatsapp.sendAlert(messages); // never throws; queues if not ready
  const status = whatsapp.getStatus();
  res.json({
    message: status.ready
      ? 'Test alert sent — check your WhatsApp'
      : 'WhatsApp not connected yet — test alert queued and will be delivered once ready',
    whatsapp: status,
  });
});

module.exports = router;
