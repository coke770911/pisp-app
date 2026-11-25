// @ts-check
/**
 * 簡易記憶體速率限制（固定視窗，依 IP 計數）。
 */

/**
 * @typedef {Object} RateLimitOptions
 * @property {number} windowMs  視窗長度（毫秒）
 * @property {number} max       視窗內允許次數
 * @property {string} message   超過時的訊息
 */

/**
 * @typedef {Object} RateLimiter
 * @property {import('express').RequestHandler} middleware
 * @property {(key: string) => void} reset  清除某個 key 的計數（例如登入成功）
 */

/**
 * 取得用戶端 IP。
 * @param {import('express').Request} req
 * @returns {string}
 */
export function clientIp(req) {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * 建立速率限制器。
 * @param {RateLimitOptions} options
 * @returns {RateLimiter}
 */
export function createRateLimiter(options) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const hits = new Map();

  // 定期清除過期紀錄，避免記憶體無限成長
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.resetAt <= now) hits.delete(key);
  }, 60_000);
  timer.unref();

  /** @type {import('express').RequestHandler} */
  const middleware = (req, res, next) => {
    const key = clientIp(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > options.max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ message: options.message });
      return;
    }
    next();
  };

  return {
    middleware,
    reset: (key) => {
      hits.delete(key);
    },
  };
}
