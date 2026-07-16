/**
 * logger.js
 * Winston logger with console + rotating file transports.
 * Files: logs/combined.log (everything) and logs/error.log (errors only).
 */
const fs = require('fs');
const path = require('path');
const winston = require('winston');

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) =>
    `${timestamp} [${level.toUpperCase()}] ${stack || message}`
  )
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack }) =>
    `${timestamp} ${level} ${stack || message}`
  )
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      format: baseFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: baseFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;
