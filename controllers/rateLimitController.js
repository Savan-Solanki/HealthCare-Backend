const RateLimitViolation = require("../models/RateLimitViolation");
const { getRedisClient, isRedisAvailable } = require("../config/redis");
const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");

exports.getViolations = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const violations = await RateLimitViolation.find()
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("userId", "name email role")
    .populate("patientUserId", "name email phone");

  const total = await RateLimitViolation.countDocuments();

  res.status(200).json({
    success: true,
    page,
    limit,
    total,
    data: violations,
  });
});

exports.getBlockedKeys = catchAsync(async (req, res) => {
  if (!isRedisAvailable()) {
    return res.status(200).json({
      success: true,
      message: "Redis is offline. Blocked keys are not managed in distributed storage.",
      data: [],
    });
  }

  const redisClient = getRedisClient();
  // Find all keys starting with rl:
  const keys = await redisClient.keys("rl:*");
  const blockedKeys = [];

  for (const key of keys) {
    const ttl = await redisClient.ttl(key);
    // If it has TTL, it is active (could be a rate limit bucket or a block)
    const points = await redisClient.get(key);
    
    // We only care about blocked keys (which have high TTL or custom flags depending on implementation)
    // For rate-limiter-flexible, blocked keys can be identified by the key name or checking TTL
    blockedKeys.push({
      key,
      ttlSeconds: ttl,
      points: parseInt(points) || 0,
    });
  }

  res.status(200).json({
    success: true,
    total: blockedKeys.length,
    data: blockedKeys,
  });
});

exports.manualUnblock = catchAsync(async (req, res, next) => {
  const { key } = req.body;
  if (!key) {
    return next(new AppError("Key is required for unblocking.", 400));
  }

  if (isRedisAvailable()) {
    const redisClient = getRedisClient();
    // Delete key from Redis (e.g. rl:user:..., rl:ip:...)
    const deleted = await redisClient.del(key);
    if (!deleted) {
      // Try with key patterns if user provided partial ID
      const matchingKeys = await redisClient.keys(`*${key}*`);
      if (matchingKeys.length > 0) {
        await redisClient.del(...matchingKeys);
      }
    }
  }

  // Also remove matching active blocks from DB violation logs just for UI sanity
  await RateLimitViolation.updateMany(
    { identifier: key, blockedUntil: { $gt: new Date() } },
    { $set: { blockedUntil: null } }
  );

  res.status(200).json({
    success: true,
    message: `Successfully unblocked key: ${key}`,
  });
});
