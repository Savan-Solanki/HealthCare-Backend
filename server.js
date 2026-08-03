"use strict";
// medikwik Backend Server
// Trigger nodemon restart to load updated env values (Admin Seeding enabled)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { corsOptions, getAllowedOrigins } = require("./config/cors");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("express-mongo-sanitize");
const path = require("path");

const connectDB = require("./config/db");
const validateEnv = require("./config/env");
const logger = require("./utils/logger");
const AppError = require("./utils/AppError");
const ensureDefaultAdmin = require("./utils/ensureDefaultAdmin");
const errorHandler = require("./middleware/errorHandler");
const ensureCorsHeaders = require("./middleware/ensureCorsHeaders");
const normalizePath = require("./middleware/normalizePath");
const { morganMiddleware, dbRequestLogger } = require("./middleware/requestLogger");

const PRODUCTION_API_ORIGIN = "https://api.medikwikhealthbuddy.in";

const normalizeApiOrigin = (value) => {
  const configured = value?.trim();

  if (!configured) {
    return PRODUCTION_API_ORIGIN;
  }

  return configured.replace(/\/api\/v1\/?$/, "").replace(/\/$/, "");
};

// ─── Route Imports ────────────────────────────────────────────────────────────
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const hospitalRoutes = require("./routes/hospitalRoutes");
const reportRoutes = require("./routes/reportRoutes");
const systemRoutes = require("./routes/systemRoutes");
const hospitalAdminRoutes = require("./routes/hospitalAdminRoutes");
const doctorRoutes = require("./routes/doctorRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const patientAuthRoutes = require("./routes/patientAuthRoutes");
const patientRoutes = require("./routes/patientRoutes");
const adRoutes = require("./routes/adRoutes");
const reminderRoutes = require("./routes/reminderRoutes");
const adminReminderRoutes = require("./routes/adminReminderRoutes");
const rateLimitRoutes = require("./routes/rateLimitRoutes");
const receiptRoutes = require("./routes/receiptRoutes");
const fileRoutes = require("./routes/fileRoutes");
const storageRoutes = require("./routes/storageRoutes");
const { startScheduledTasks } = require("./jobs/scheduledTasks");

validateEnv();

// ─── Connect to DB ────────────────────────────────────────────────────────────
connectDB()
  .then(() => ensureDefaultAdmin())
  .then(() => {
    startScheduledTasks();
  })
  .catch((error) => {
    logger.error(`Startup initialization error: ${error.message}`);
    process.exit(1);
  });

// ─── App Init ─────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: false, // Handled by Next.js frontend
  })
);

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const { rateLimiterMiddleware } = require("./middleware/rateLimiter");

app.use("/api", rateLimiterMiddleware);

app.use(
  express.json({
    limit: "10kb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// ─── Data Sanitization ────────────────────────────────────────────────────────
// Prevent NoSQL injection (strips $  and . from keys)
app.use(mongoSanitize());

// ─── Compression ──────────────────────────────────────────────────────────────
app.use(compression());

// ─── Request Logging ──────────────────────────────────────────────────────────
app.use(morganMiddleware);
app.use(dbRequestLogger);
app.use(normalizePath);

const API_PREFIX = "/api/v1";

// ─── Health Check (unauthenticated) ──────────────────────────────────────────
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "MedKwik HealthBuddy API is running",
    apiBase: `${API_PREFIX}`,
    health: "/health",
    docs: `${API_PREFIX} (GET for endpoint index)`,
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.get("/api", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Use /api/v1 as the API base path.",
    apiBase: API_PREFIX,
    productionUrl: `${normalizeApiOrigin(process.env.API_BASE_URL)}${API_PREFIX}`,
  });
});

const legacyAuthHint = (req, res) => {
  const suffix = req.path === "/" ? "" : req.path;
  res.status(405).json({
    success: false,
    message: "Staff authentication endpoints require POST requests under /api/v1/auth.",
    methodRequired: "POST",
    correctEndpoint: `${API_PREFIX}/auth${suffix}`,
    example: {
      login: `POST ${API_PREFIX}/auth/login`,
      refresh: `POST ${API_PREFIX}/auth/refresh`,
    },
  });
};

app.use("/auth", legacyAuthHint);

app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);
app.use(`${API_PREFIX}/hospitals`, hospitalRoutes);
app.use(`${API_PREFIX}/reports`, reportRoutes);
app.use(`${API_PREFIX}/system`, systemRoutes);
app.use(`${API_PREFIX}/hospital-admin`, hospitalAdminRoutes);
app.use(`${API_PREFIX}/doctor`, doctorRoutes);
app.use(`${API_PREFIX}/notifications`, notificationRoutes);
app.use(`${API_PREFIX}/patient/auth`, patientAuthRoutes);
app.use(`${API_PREFIX}/patient`, patientRoutes);
app.use(`${API_PREFIX}/ads`, adRoutes);
app.use(`${API_PREFIX}/patient`, reminderRoutes);
app.use(`${API_PREFIX}/admin/reminders`, adminReminderRoutes);
app.use(`${API_PREFIX}/admin/rate-limits`, rateLimitRoutes);
app.use(`${API_PREFIX}/receipts`, receiptRoutes);
app.use(`${API_PREFIX}/files`, fileRoutes);
app.use(`${API_PREFIX}/admin/storage`, storageRoutes);

// ─── API root info ────────────────────────────────────────────────────────────
app.get(API_PREFIX, (req, res) => {
  res.status(200).json({
    success: true,
    name: "MedKwik HealthBuddy API",
    version: "1.0.0",
    baseUrl: `${normalizeApiOrigin(process.env.API_BASE_URL)}${API_PREFIX}`,
    authentication: {
      staff: `${API_PREFIX}/auth`,
      patient: `${API_PREFIX}/patient/auth`,
      refreshCookies: {
        superAdmin: "sa_refreshToken",
        hospitalAdmin: "ha_refreshToken",
        receptionist: "re_refreshToken",
        doctor: "dr_refreshToken",
        patient: "pt_refreshToken",
      },
    },
    endpoints: {
      auth: `${API_PREFIX}/auth`,
      users: `${API_PREFIX}/users`,
      hospitals: `${API_PREFIX}/hospitals`,
      reports: `${API_PREFIX}/reports`,
      system: `${API_PREFIX}/system`,
      hospitalAdmin: `${API_PREFIX}/hospital-admin`,
      doctor: `${API_PREFIX}/doctor`,
      notifications: `${API_PREFIX}/notifications`,
      patientAuth: `${API_PREFIX}/patient/auth`,
      patient: `${API_PREFIX}/patient`,
    },
    notes: [
      "All auth refresh endpoints require POST, not GET.",
      "Protected routes need Authorization: Bearer <accessToken>.",
      "OTP login requires SMTP_* env vars on Render.",
    ],
  });
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.all("*", (req, res, next) => {
  next(new AppError(`Route ${req.originalUrl} not found on this server.`, 404));
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use(ensureCorsHeaders);
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
const http = require("http");
const { initSocketIO } = require("./config/socketio");

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Initialize Socket.IO with CORS settings
initSocketIO(server, getAllowedOrigins());

server.listen(PORT, () => {
  logger.info(`🚀 MedKwik API running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  logger.info(`📡 Base URL: ${normalizeApiOrigin(process.env.API_BASE_URL)}${API_PREFIX}`);
  logger.info(`🌐 Allowed CORS origins: ${getAllowedOrigins().join(", ")}`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = (signal) => {
  logger.warn(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });
  // Force close after 10s
  setTimeout(() => {
    logger.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Unhandled Promise Rejections ─────────────────────────────────────────────
process.on("unhandledRejection", (err) => {
  logger.error(`UNHANDLED REJECTION: ${err.message}`);
  shutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  logger.error(`UNCAUGHT EXCEPTION: ${err.message}`);
  process.exit(1);
});

module.exports = app;
