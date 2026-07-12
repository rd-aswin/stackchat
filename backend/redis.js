const Redis = require('ioredis');
require('dotenv').config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

console.log(`Connecting to Redis at ${redisUrl}...`);

const pubClient = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true
});

const subClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err));
subClient.on('error', (err) => console.error('Redis Sub Client Error:', err));

module.exports = {
  pubClient,
  subClient,
  redisUrl
};
