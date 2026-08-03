const morgan = require("morgan");
const logger = require("../utils/logger");
const Log = require("../models/Log");

// ─── Morgan stream → Winston ───────────────────────────────────────────────────
const morganStream = {
  write: (message) => logger.http(message.trim()),
};

// ─── Morgan format ────────────────────────────────────────────────────────────
const morganMiddleware = morgan(
  ":method :url :status :res[content-length] - :response-time ms",
  {
    stream: morganStream,
    skip: (req) =>
      req.url === "/api/v1/system/status" || req.url === "/health", // skip health checks
  }
);

// ─── DB Request Logger ────────────────────────────────────────────────────────
// Persists HTTP request logs to MongoDB (async, non-blocking)
const dbRequestLogger = (req, res, next) => {
  const startHrTime = process.hrtime();

  res.on("finish", async () => {
    // Only log API routes
    if (!req.path.startsWith("/api")) return;

    const elapsedHrTime = process.hrtime(startHrTime);
    const elapsedMs = Math.round(
      elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6
    );

    const level =
      res.statusCode >= 500
        ? "error"
        : res.statusCode >= 400
        ? "warning"
        : "info";

    try {
      await Log.create({
        level,
        message: `${req.method} ${req.path} → ${res.statusCode}`,
        source: "http",
        userId: req.user?._id || null,
        ip: req.ip,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        responseTime: elapsedMs,
      });
    } catch (_) {
      // Silent — never crash the request due to logging failure
    }
  });

  next();
};

module.exports = { morganMiddleware, dbRequestLogger };
