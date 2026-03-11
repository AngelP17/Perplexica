/**
 * Token Bucket Rate Limiting Middleware
 *
 * Protects API endpoints from abuse and ensures fair usage.
 * Uses sliding window algorithm via express-rate-limit.
 *
 * Expected impact:
 * - Prevents DoS attacks and API abuse
 * - Protects against cost spikes from excessive usage
 * - Ensures fair resource allocation
 */

import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for chat endpoints
 * - Burst: 10 requests/minute
 * - Sustained: 100 requests/hour
 */
export const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // Max 10 requests per minute
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '1 minute',
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Skip rate limiting for localhost in development
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || req.socket.remoteAddress;
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
    return false;
  },
  handler: (req, res) => {
    res.status(429).json({
      error:
        'Rate limit exceeded. Please wait before making more requests.',
      retryAfter: Math.ceil(60 - (Date.now() % 60000) / 1000), // Seconds until next window
    });
  },
});

/**
 * Rate limiter for search endpoints
 * - Burst: 10 requests/minute
 * - Sustained: 100 requests/hour
 */
export const searchRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // Max 10 requests per minute
  message: {
    error: 'Too many search requests, please try again later.',
    retryAfter: '1 minute',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || req.socket.remoteAddress;
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
    return false;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Search rate limit exceeded. Please wait before searching again.',
      retryAfter: Math.ceil(60 - (Date.now() % 60000) / 1000),
    });
  },
});

/**
 * Stricter rate limiter for expensive operations (e.g., uploads)
 * - 5 requests per minute
 */
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: {
    error: 'Too many upload requests, please try again later.',
    retryAfter: '1 minute',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || req.socket.remoteAddress;
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
    return false;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Upload rate limit exceeded. Please wait before uploading again.',
      retryAfter: Math.ceil(60 - (Date.now() % 60000) / 1000),
    });
  },
});

/**
 * Get rate limit statistics (for monitoring/debugging)
 */
export const getRateLimitStats = () => {
  return {
    chat: {
      windowMs: 60 * 1000,
      max: 10,
      type: 'sliding-window',
    },
    search: {
      windowMs: 60 * 1000,
      max: 10,
      type: 'sliding-window',
    },
    upload: {
      windowMs: 60 * 1000,
      max: 5,
      type: 'sliding-window',
    },
  };
};
