const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
const path = require("path");

const { combine, timestamp, printf, colorize, errors } = winston.format;

// ─── Custom log format ────────────────────────────────────────────────────────
const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

// ─── Transports ───────────────────────────────────────────────────────────────
const transports = [
  // Console: colorized, only in development
  new winston.transports.Console({
    level: process.env.NODE_ENV === "production" ? "warn" : "debug",
    format: combine(
      colorize({ all: true }),
      timestamp({ format: "HH:mm:ss" }),
      errors({ stack: true }),
      logFormat
    ),
  }),

  // Daily rotating error log
  new DailyRotateFile({
    filename: path.join("logs", "error-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    level: "error",
    maxSize: "20m",
    maxFiles: "30d",
    format: combine(timestamp(), errors({ stack: true }), winston.format.json()),
  }),

  // Daily rotating combined log
  new DailyRotateFile({
    filename: path.join("logs", "combined-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    maxSize: "50m",
    maxFiles: "14d",
    format: combine(timestamp(), errors({ stack: true }), winston.format.json()),
  }),
];

const logger = winston.createLogger({
  level: "info",
  format: combine(timestamp(), errors({ stack: true }), winston.format.json()),
  transports,
  exitOnError: false,
});

module.exports = logger;
