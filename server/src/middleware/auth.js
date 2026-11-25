// @ts-check
/**
 * Session 管理（記憶體 Map）與 requireAuth 中介層。
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** Session cookie 名稱 */
export const SESSION_COOKIE = 'hisp_sid';

/** 未登入或逾時的統一訊息 */
export const UNAUTHORIZED_MESSAGE = '登入逾時，請重新登入';

/**
 * @typedef {Object} Session
 * @property {string} username
 * @property {number} expiresAt  到期時間（epoch ms）
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/** Session 有效毫秒數 */
export const SESSION_TTL_MS = Math.max(1, env.SESSION_TTL_HOURS) * 60 * 60 * 1000;

// 定期清除過期 session
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token);
}, 10 * 60 * 1000);
cleanupTimer.unref();

/**
 * 建立新 session，回傳 token（32 bytes 隨機值）。
 * @param {string} username
 * @returns {string}
 */
export function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

/**
 * 取得有效 session（過期即刪除）。
 * @param {unknown} token
 * @returns {Session | null}
 */
export function getSession(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/**
 * @param {unknown} token
 */
export function destroySession(token) {
  if (typeof token === 'string') sessions.delete(token);
}

/**
 * 從請求讀出 session token。
 * @param {import('express').Request} req
 * @returns {string | undefined}
 */
export function readSessionToken(req) {
  /** @type {Record<string, unknown>} */
  const cookies = req.cookies ?? {};
  const v = cookies[SESSION_COOKIE];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 需登入才能存取。
 * @type {import('express').RequestHandler}
 */
export function requireAuth(req, res, next) {
  const session = getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ message: UNAUTHORIZED_MESSAGE });
    return;
  }
  res.locals.username = session.username;
  next();
}
