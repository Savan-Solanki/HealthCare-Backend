const os = require("os");
const mongoose = require("mongoose");
const Log = require("../models/Log");
const Activity = require("../models/Activity");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");
const logger = require("../utils/logger");

// ─── GET /api/v1/system/status ────────────────────────────────────────────────
exports.getSystemStatus = catchAsync(async (req, res, next) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus =
    dbState === 1 ? "connected" : dbState === 2 ? "connecting" : "disconnected";

  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsedPct = Math.round(((memTotal - memFree) / memTotal) * 100);

  const cpuLoad = os.loadavg(); // [1m, 5m, 15m]

  const uptimeSeconds = process.uptime();
  const uptimeHuman = new Date(uptimeSeconds * 1000).toISOString().substr(11, 8);

  // Categorise overall health
  let overallHealth = "healthy";
  if (dbStatus !== "connected") overallHealth = "degraded";
  if (memUsedPct > 90) overallHealth = "critical";

  res.status(200).json({
    success: true,
    data: {
      status: overallHealth,
      timestamp: new Date().toISOString(),
      server: {
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        uptime: uptimeHuman,
        uptimeSeconds: Math.round(uptimeSeconds),
        pid: process.pid,
      },
      cpu: {
        cores: os.cpus().length,
        model: os.cpus()[0]?.model,
        loadAvg1m: cpuLoad[0].toFixed(2),
        loadAvg5m: cpuLoad[1].toFixed(2),
        loadAvg15m: cpuLoad[2].toFixed(2),
      },
      memory: {
        totalMB: Math.round(memTotal / 1024 / 1024),
        freeMB: Math.round(memFree / 1024 / 1024),
        usedMB: Math.round((memTotal - memFree) / 1024 / 1024),
        usedPercent: memUsedPct,
      },
      database: {
        status: dbStatus,
        host: mongoose.connection.host,
        name: mongoose.connection.name,
      },
      security: {
        jwtEnabled: !!process.env.JWT_SECRET,
        corsEnabled: true,
        rateLimitEnabled: true,
        helmetEnabled: true,
      },
    },
  });
});

// ─── GET /api/v1/system/logs ──────────────────────────────────────────────────
exports.getSystemLogs = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.level) filter.level = req.query.level;
  if (req.query.source) filter.source = req.query.source;
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }

  const [logs, total] = await Promise.all([
    Log.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name email"),
    Log.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: logs,
  });
});

// ─── POST /api/v1/system/action ───────────────────────────────────────────────
exports.triggerSystemAction = catchAsync(async (req, res, next) => {
  const { action } = req.body;

  const ALLOWED_ACTIONS = ["backup", "security_update", "restart_services", "clear_cache"];

  if (!action) return next(new AppError("Action is required.", 400));
  if (!ALLOWED_ACTIONS.includes(action.toLowerCase()))
    return next(new AppError(`Unknown action. Allowed: ${ALLOWED_ACTIONS.join(", ")}`, 400));

  // Simulate action execution (replace with real implementations)
  const results = {
    backup: {
      message: "System backup initiated successfully.",
      details: `Backup job queued at ${new Date().toISOString()}`,
    },
    security_update: {
      message: "Security update scan initiated.",
      details: "Running vulnerability scan and applying patches...",
    },
    restart_services: {
      message: "Service restart scheduled.",
      details: "Services will restart gracefully within 60 seconds.",
    },
    clear_cache: {
      message: "Cache cleared successfully.",
      details: "In-memory cache flushed.",
    },
  };

  const result = results[action.toLowerCase()];

  // Create a log entry
  await Log.create({
    level: "info",
    message: `System action triggered: ${action.toUpperCase()} by ${req.user.name}`,
    source: "system-action",
    userId: req.user._id,
    ip: req.ip,
    meta: { action, result },
  });

  await recordActivity({
    action: `SYSTEM_${action.toUpperCase()}`,
    entity: "System",
    user: req.user,
    description: result.message,
    ip: req.ip,
    meta: { action },
  });

  logger.info(`[SYSTEM ACTION] ${action} triggered by ${req.user.email}`);

  res.status(200).json({
    success: true,
    action,
    ...result,
    triggeredBy: req.user.name,
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /api/v1/system/activity ─────────────────────────────────────────────
exports.getSystemActivity = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.entity) filter.entity = req.query.entity;
  if (req.query.action) filter.action = { $regex: req.query.action, $options: "i" };

  const [activities, total] = await Promise.all([
    Activity.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name email role"),
    Activity.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: activities,
  });
});
