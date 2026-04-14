const { createClient } = require('redis');

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

client.on('error', (err) => {
  console.error('Redis client error:', err.message);
});

client.on('connect', () => {
  console.log('Redis connected successfully');
});

client.on('reconnecting', () => {
  console.log('Redis reconnecting...');
});

/**
 * Connect to Redis.
 * @returns {Promise<void>}
 */
async function connect() {
  if (!client.isOpen) {
    await client.connect();
  }
}

/**
 * Set a key with an optional TTL in seconds.
 * @param {string} key
 * @param {string} value
 * @param {number} [ttlSeconds]
 */
async function set(key, value, ttlSeconds) {
  if (ttlSeconds) {
    await client.set(key, value, { EX: ttlSeconds });
  } else {
    await client.set(key, value);
  }
}

/**
 * Get a value by key.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function get(key) {
  return client.get(key);
}

/**
 * Delete one or more keys.
 * @param {...string} keys
 */
async function del(...keys) {
  return client.del(keys);
}

/**
 * Check if a key exists.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function exists(key) {
  const count = await client.exists(key);
  return count > 0;
}

module.exports = { client, connect, set, get, del, exists };
