const Redis = require("ioredis");
const logger = require("../utils/logger");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

let redisClient = null;
let isRedisAvailable = false;

const ENABLE_REDIS = process.env.ENABLE_REDIS === "true";

try {
  if (ENABLE_REDIS) {
    logger.info(`Initializing Redis client with URL: ${REDIS_URL}`);
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    });

    redisClient.on("connect", () => {
      isRedisAvailable = true;
      logger.info("Successfully connected to Redis server.");
    });

    redisClient.on("error", (error) => {
      isRedisAvailable = false;
      logger.error("Redis connection error:", error);
    });
  } else {
    logger.info("Redis is disabled. Using local in-memory fallback.");
  }
} catch (error) {
  logger.error("Error creating Redis client:", error);
  isRedisAvailable = false;
}

const getRedisClient = () => {
  return redisClient;
};

const checkRedisHealth = async () => {
  if (!redisClient || !isRedisAvailable) return false;
  try {
    const pong = await redisClient.ping();
    return pong === "PONG";
  } catch (error) {
    logger.error("Redis ping healthcheck failed:", error);
    return false;
  }
};

module.exports = {
  getRedisClient,
  checkRedisHealth,
  isRedisAvailable: () => isRedisAvailable,
};
