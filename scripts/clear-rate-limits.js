const mongoose = require('mongoose');
const Redis = require('ioredis');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

async function main() {
  if (!MONGO_URI) {
    console.error('MONGO_URI is not defined in the environment.');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  console.log('Clearing MongoDB rate limit violations...');
  const res = await mongoose.connection.collection('ratelimitviolations').deleteMany({});
  console.log(`Deleted ${res.deletedCount} violations from MongoDB.`);

  console.log('Connecting to Redis...');
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  
  try {
    const keys = await redis.keys('rl:*');
    console.log(`Found ${keys.length} rate limit keys in Redis.`);
    if (keys.length > 0) {
      const deleted = await redis.del(...keys);
      console.log(`Deleted ${deleted} rate limit keys from Redis.`);
    }
  } catch (err) {
    console.warn('Could not connect to Redis, or Redis is not running. Skipped Redis key cleanup. Error:', err.message);
  } finally {
    redis.disconnect();
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => {
  console.error('Error running script:', err);
  process.exit(1);
});
