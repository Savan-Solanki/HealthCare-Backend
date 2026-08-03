const { RateLimiterRedis, RateLimiterMemory } = require("rate-limiter-flexible");
const jwt = require("jsonwebtoken");
const { getRedisClient, isRedisAvailable } = require("../config/redis");
const RateLimitViolation = require("../models/RateLimitViolation");
const logger = require("../utils/logger");

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Main rate limit rules: 20 requests per second, then a short temporary block.
const LIMIT_POINTS = toPositiveInt(process.env.RATE_LIMIT_POINTS, 20);
const LIMIT_DURATION = toPositiveInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 1);
const BLOCK_DURATION = toPositiveInt(process.env.RATE_LIMIT_BLOCK_SECONDS, 60);

let limiterUser = null;
let limiterIp = null;
let limiterDevice = null;

// Initialize limiters
const initLimiters = () => {
  const redisClient = getRedisClient();
  const redisAvailable = isRedisAvailable();

  if (redisAvailable && redisClient) {
    limiterUser = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: "rl:user",
      points: LIMIT_POINTS,
      duration: LIMIT_DURATION,
      blockDuration: BLOCK_DURATION,
    });

    limiterIp = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: "rl:ip",
      points: LIMIT_POINTS,
      duration: LIMIT_DURATION,
      blockDuration: BLOCK_DURATION,
    });

    limiterDevice = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: "rl:df",
      points: LIMIT_POINTS,
      duration: LIMIT_DURATION,
      blockDuration: BLOCK_DURATION,
    });
    logger.info("Distributed rate limiters initialized using Redis store.");
  } else {
    // Graceful fallback to memory limiter
    limiterUser = new RateLimiterMemory({
      keyPrefix: "rl:user",
      points: LIMIT_POINTS,
      duration: LIMIT_DURATION,
      blockDuration: BLOCK_DURATION,
    });

    limiterIp = new RateLimiterMemory({
      keyPrefix: "rl:ip",
      points: LIMIT_POINTS,
      duration: LIMIT_DURATION,
      blockDuration: BLOCK_DURATION,
    });

    limiterDevice = new RateLimiterMemory({
      keyPrefix: "rl:df",
      points: LIMIT_POINTS,
      duration: LIMIT_DURATION,
      blockDuration: BLOCK_DURATION,
    });
    logger.warn("Redis is unavailable. Initialized rate limiters using local memory fallback.");
  }
};

// Exclude WebSocket upgrades, heartbeats, and all auth routes from rate limiting
const shouldSkipRateLimit = (req) => {
  // Exclude WebSocket upgrades
  const isWsUpgrade =
    req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket";
  if (isWsUpgrade) return true;

  // Exclude heartbeats and SSE notification streams
  const isHeartbeat =
    req.path.includes("/heartbeat") || req.path.includes("/stream");
  if (isHeartbeat) return true;

  // IMPORTANT: Exclude all authentication endpoints (login, OTP, signup, password reset)
  // so that a rate-limited user can still authenticate.  Auth endpoints have their own
  // dedicated per-route limiters (loginLimiter, otpLimiter) defined in their controllers.
  const isAuthRoute = req.path.includes("/auth/");
  if (isAuthRoute) return true;

  return false;
};

// Try to parse JWT token from request
const getUserIdFromToken = (req) => {
  let token = null;

  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.id || null;
  } catch {
    return null;
  }
};

const rateLimiterMiddleware = async (req, res, next) => {
  if (shouldSkipRateLimit(req)) {
    return next();
  }

  // Ensure limiters are initialized
  if (!limiterUser || !limiterIp || !limiterDevice) {
    initLimiters();
  }

  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)[0];
  const ip = req.ip || forwardedFor || req.socket.remoteAddress;
  const deviceFingerprint = req.headers["x-device-fingerprint"];
  const userId = getUserIdFromToken(req);

  // Run all limiters in parallel. If any key is blocked, return 429 and audit the exact key.
  const checks = [];

  // 1. User Account limit (if authenticated)
  if (userId) {
    checks.push({ key: userId, type: "userId", promise: limiterUser.consume(userId) });
  }

  // 2. IP Address limit
  if (ip) {
    checks.push({ key: ip, type: "ip", promise: limiterIp.consume(ip) });
  }

  // 3. Device Fingerprint limit
  if (deviceFingerprint) {
    checks.push({
      key: deviceFingerprint,
      type: "deviceFingerprint",
      promise: limiterDevice.consume(deviceFingerprint),
    });
  }

  const results = await Promise.allSettled(checks.map((check) => check.promise));
  const rejectedIndex = results.findIndex((result) => result.status === "rejected");

  if (rejectedIndex === -1) {
    return next();
  }

  const failedKey = checks[rejectedIndex] || { key: ip || "unknown", type: "ip" };
  const rejectRes = results[rejectedIndex].reason || {};

  try {
    const isBlocked = rejectRes.msBeforeNext > 0;
    const remainingTimeSeconds = Math.ceil(rejectRes.msBeforeNext / 1000);
    const retryAfter = isBlocked ? remainingTimeSeconds : Math.ceil(LIMIT_DURATION);

    res.set("Retry-After", String(retryAfter));
    res.set("X-RateLimit-Limit", String(LIMIT_POINTS));
    res.set("X-RateLimit-Remaining", "0");
    res.set("X-RateLimit-Reset", new Date(Date.now() + retryAfter * 1000).toISOString());

    // Record violation audit log
    try {
      const blockedUntil = isBlocked ? new Date(Date.now() + rejectRes.msBeforeNext) : null;
      await RateLimitViolation.create({
        identifier: failedKey.key,
        identifierType: failedKey.type,
        endpoint: req.originalUrl || req.url,
        method: req.method,
        requestCount: rejectRes.consumedPoints || LIMIT_POINTS + 1,
        windowMs: LIMIT_DURATION * 1000,
        blockedUntil,
        userAgent: req.headers["user-agent"] || null,
        ip: ip || null,
        userId: failedKey.type === "userId" ? failedKey.key : userId,
        patientUserId: failedKey.type === "userId" ? failedKey.key : null,
      });
    } catch (dbErr) {
      logger.error("Failed to log rate limit violation to DB:", dbErr);
    }

    res.status(429).json({
      success: false,
      message: "Too many requests from this IP or account. Please try again shortly.",
      error: "RateLimitExceeded",
      retryAfterSeconds: retryAfter,
      blocked: isBlocked,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  rateLimiterMiddleware,
  initLimiters,
};
