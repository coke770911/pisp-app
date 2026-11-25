// @ts-check
/**
 * 認證 API：login / logout / me。
 * 硬帳密來自環境變數；以 scrypt 雜湊後 timingSafeEqual 比對，避免時間差洩漏。
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  UNAUTHORIZED_MESSAGE,
  createSession,
  destroySession,
  getSession,
  readSessionToken,
} from '../middleware/auth.js';
import { clientIp, createRateLimiter } from '../middleware/rateLimit.js';

/**
 * scrypt 的 Promise 版本。
 * @param {string} input
 * @param {Buffer} saltValue
 * @param {number} keyLen
 * @returns {Promise<Buffer>}
 */
function scryptAsync(input, saltValue, keyLen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, saltValue, keyLen, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const LOGIN_FAILED_MESSAGE = '帳號或密碼錯誤';
const SERVICE_UNAVAILABLE_MESSAGE = '服務暫時無法使用';
const KEY_LEN = 64;

/** 每次啟動產生隨機 salt，啟動時預先算好正確帳密的雜湊 */
const salt = crypto.randomBytes(16);
/** @type {Promise<{ user: Buffer, pass: Buffer } | null>} */
const expectedPromise =
  env.ADMIN_USERNAME && env.ADMIN_PASSWORD
    ? Promise.all([scryptAsync(env.ADMIN_USERNAME, salt, KEY_LEN), scryptAsync(env.ADMIN_PASSWORD, salt, KEY_LEN)]).then(
        ([user, pass]) => ({ user, pass }),
      )
    : Promise.resolve(null);

const loginBodySchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Math.max(1, env.LOGIN_RATE_LIMIT),
  message: '嘗試次數過多，請稍後再試',
});

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 比對帳密：無論帳號是否正確都計算帳號與密碼兩次 scrypt（同成本）。
 * @param {string} username
 * @param {string} password
 * @param {{ user: Buffer, pass: Buffer }} expected
 * @returns {Promise<boolean>}
 */
async function verifyCredentials(username, password, expected) {
  const [u, p] = await Promise.all([scryptAsync(username, salt, KEY_LEN), scryptAsync(password, salt, KEY_LEN)]);
  const userOk = crypto.timingSafeEqual(u, expected.user);
  const passOk = crypto.timingSafeEqual(p, expected.pass);
  return userOk && passOk;
}

/**
 * Session cookie 選項。
 * @returns {import('express').CookieOptions}
 */
function cookieOptions() {
  return { httpOnly: true, sameSite: 'strict', secure: env.COOKIE_SECURE, path: '/' };
}

export const authRouter = Router();

authRouter.post('/login', loginLimiter.middleware, async (req, res) => {
  const startedAt = Date.now();
  const expected = await expectedPromise;
  if (!expected) {
    res.status(503).json({ message: SERVICE_UNAVAILABLE_MESSAGE });
    return;
  }

  const parsed = loginBodySchema.safeParse(req.body);
  // 格式錯誤也做一次同成本的假比對，回應時間與一般失敗一致
  const ok = parsed.success
    ? await verifyCredentials(parsed.data.username, parsed.data.password, expected)
    : await verifyCredentials('', 'invalid-input', expected).then(() => false);

  if (!ok || !parsed.success) {
    const remaining = env.LOGIN_MIN_DELAY_MS - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    res.status(401).json({ message: LOGIN_FAILED_MESSAGE });
    return;
  }

  // 登入成功：舊 session 作廢、清除此 IP 的嘗試計數
  destroySession(readSessionToken(req));
  loginLimiter.reset(clientIp(req));
  const token = createSession(env.ADMIN_USERNAME);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
  res.json({ username: env.ADMIN_USERNAME });
});

authRouter.post('/logout', (req, res) => {
  destroySession(readSessionToken(req));
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const session = getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ message: UNAUTHORIZED_MESSAGE });
    return;
  }
  res.json({ username: session.username });
});
