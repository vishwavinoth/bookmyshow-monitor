/**
 * whatsapp.js
 * WhatsApp notifications via whatsapp-web.js with LocalAuth.
 *
 * - First run prints a QR code in the terminal; scan it once with the
 *   WhatsApp mobile app. The session persists in .wwebjs_auth/ so
 *   subsequent starts authenticate silently.
 * - Alerts raised before the client is ready are queued and flushed on
 *   'ready', so the very first scan can never lose a notification.
 * - Disconnects trigger an automatic re-initialisation.
 */
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger = require('./logger');
const { config } = require('./utils');

const MAX_QUEUE = 20;
const RECONNECT_DELAY_MS = 30000;

let client = null;
let ready = false;
const chatIds = new Map(); // recipient -> resolved chat id, cached on first send
const pending = [];

function getStatus() {
  return { ready, queuedMessages: pending.length, recipients: config.whatsappNumbers.length };
}

function init() {
  ready = false;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', (qr) => {
    logger.info(
      'WhatsApp QR code received — scan it with your phone: WhatsApp > Settings > Linked devices > Link a device'
    );
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp authenticated (session stored via LocalAuth — QR not needed next time)');
  });

  client.on('auth_failure', (message) => {
    logger.error(`WhatsApp authentication failed: ${message}. Delete .wwebjs_auth/ and restart to re-pair.`);
  });

  client.on('ready', () => {
    ready = true;
    logger.info('WhatsApp client is ready');
    flushQueue().catch((err) => logger.error(`Failed to flush queued alerts: ${err.message}`));
  });

  client.on('disconnected', async (reason) => {
    ready = false;
    chatIds.clear();
    logger.error(`WhatsApp disconnected (${reason}) — re-initialising in ${RECONNECT_DELAY_MS / 1000}s`);
    try {
      await client.destroy();
    } catch {
      /* already gone */
    }
    setTimeout(init, RECONNECT_DELAY_MS);
  });

  client.initialize().catch((err) => {
    logger.error(`WhatsApp initialisation failed: ${err.message} — retrying in ${RECONNECT_DELAY_MS / 1000}s`);
    setTimeout(init, RECONNECT_DELAY_MS);
  });
}

/** Resolve a recipient's chat id once; prefer the registered id from WhatsApp. */
async function resolveChatId(recipient) {
  if (chatIds.has(recipient)) return chatIds.get(recipient);
  // Group ids ("...@g.us") and pre-resolved ids are used as-is.
  if (recipient.includes('@')) {
    chatIds.set(recipient, recipient);
    return recipient;
  }
  let id = `${recipient}@c.us`;
  try {
    const numberId = await client.getNumberId(recipient);
    if (numberId) {
      id = numberId._serialized;
    } else {
      logger.warn(`WhatsApp could not verify ${recipient} — falling back to <number>@c.us`);
    }
  } catch (err) {
    logger.warn(`getNumberId failed for ${recipient} (${err.message}) — falling back to <number>@c.us`);
  }
  chatIds.set(recipient, id);
  return id;
}

async function flushQueue() {
  while (ready && pending.length) {
    const body = pending.shift();
    await deliver(body);
  }
}

/** Send one message body to every configured recipient (best effort each). */
async function deliver(body) {
  if (!config.whatsappNumbers.length) {
    logger.error('No WhatsApp recipients configured — set WHATSAPP_NUMBERS in .env');
    return;
  }
  let delivered = 0;
  for (const recipient of config.whatsappNumbers) {
    try {
      const id = await resolveChatId(recipient);
      await client.sendMessage(id, body);
      delivered += 1;
    } catch (err) {
      logger.error(`Failed to send WhatsApp message to ${recipient}: ${err.message}`);
    }
  }
  logger.info(`WhatsApp message sent to ${delivered}/${config.whatsappNumbers.length} recipient(s)`);
}

/**
 * Send the poster image (with a short caption) to every recipient.
 * Strictly best-effort: any failure just falls back to text-only alerts.
 * The image is downloaded once and reused for all recipients.
 */
async function deliverImage(imageUrl, caption) {
  if (!config.whatsappNumbers.length) return;
  let media;
  try {
    media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
  } catch (err) {
    logger.warn(`Could not fetch poster image (${err.message}) — sending text-only alert`);
    return;
  }
  let delivered = 0;
  for (const recipient of config.whatsappNumbers) {
    try {
      const id = await resolveChatId(recipient);
      await client.sendMessage(id, media, caption ? { caption } : {});
      delivered += 1;
    } catch (err) {
      logger.warn(`Failed to send poster to ${recipient}: ${err.message}`);
    }
  }
  if (delivered) {
    logger.info(`Poster image sent to ${delivered}/${config.whatsappNumbers.length} recipient(s)`);
  }
}

/**
 * Send one or more alert messages, optionally preceded by a poster image
 * (options: { imageUrl, imageCaption }). If the client is not ready yet the
 * text messages are queued (bounded) and sent as soon as it becomes ready;
 * the image is skipped when not ready — it is decoration, not data.
 * Never throws — a notification failure must not break the monitor loop.
 */
async function sendAlert(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [messages];

  if (options.imageUrl && ready) {
    await deliverImage(options.imageUrl, options.imageCaption || '');
  }
  for (const body of list) {
    if (!ready) {
      if (pending.length < MAX_QUEUE) {
        pending.push(body);
        logger.warn('WhatsApp client not ready — alert queued for delivery');
      } else {
        logger.error('WhatsApp client not ready and queue is full — alert dropped');
      }
      continue;
    }
    try {
      await deliver(body);
    } catch (err) {
      logger.error(`Failed to send WhatsApp message: ${err.message}`);
    }
  }
}

async function shutdown() {
  if (client) {
    await client.destroy().catch(() => {});
    client = null;
    ready = false;
  }
}

module.exports = { init, sendAlert, getStatus, shutdown };
