const rateLimitMap = {};

/**
 * Lightweight, zero-dependency in-memory sliding window rate limiter middleware.
 * @param {number} limit Maximum requests permitted in window.
 * @param {number} windowMs Window duration in milliseconds.
 */
const rateLimiter = (limit, windowMs) => {
  return (req, res, next) => {
    // Fallback to connection remote address if ip property is missing
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();

    if (!rateLimitMap[ip]) {
      rateLimitMap[ip] = [];
    }

    // Retain request timestamps only within the current sliding window
    rateLimitMap[ip] = rateLimitMap[ip].filter((timestamp) => now - timestamp < windowMs);

    if (rateLimitMap[ip].length >= limit) {
      return res.status(429).json({
        error: `Too many requests from this IP. Limit is ${limit} requests per ${windowMs / 1000 / 60} minutes. Please try again later.`
      });
    }

    rateLimitMap[ip].push(now);
    next();
  };
};

module.exports = rateLimiter;
