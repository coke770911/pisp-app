// @ts-check
/**
 * Session 管理（記憶體 Map）與 requireAuth / requireAdmin 中介層。
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** Session cookie 名稱 */
export const SESSION_COOKIE = 'hisp_sid';

/** 未登入或逾時的統一訊息 */
export const UNAUTHORIZED_MESSAGE = '登入逾時，請重新登入';

/** 非管理者存取管理功能的訊息 */
export const FORBIDDEN_MESSAGE = '權限不足';

/**
 * @typedef {Object} SessionUser
 * @property {string} account      校內帳號（小寫）
 * @property {string} displayName  顯示名稱
 * @property {string} role         'admin' | 'user'
 */

/**
 * @typedef {SessionUser & { expiresAt: number }} Session  expiresAt：到期時間（epoch ms）
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
 * @param {SessionUser} user
 * @returns {string}
 */
export function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    account: user.account,
    displayName: user.displayName,
    role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
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
 * 清除某帳號的所有 session（帳號被停用或刪除時）。
 * @param {string} account
 * @returns {number} 清除筆數
 */
export function destroySessionsByAccount(account) {
  let n = 0;
  for (const [token, s] of sessions) {
    if (s.account === account) {
      sessions.delete(token);
      n += 1;
    }
  }
  return n;
}

/**
 * 更新某帳號所有 session 的角色（帳號被升級或降級時）。
 * @param {string} account
 * @param {string} role
 * @returns {number} 更新筆數
 */
export function updateSessionsRole(account, role) {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.account === account) {
      s.role = role;
      n += 1;
    }
  }
  return n;
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
 * 取得 requireAuth 存入的目前使用者。
 * @param {import('express').Response} res
 * @returns {SessionUser}
 */
export function currentUser(res) {
  /** @type {unknown} */
  const u = res.locals.user;
  if (
    typeof u !== 'object' ||
    u === null ||
    !('account' in u) ||
    !('displayName' in u) ||
    !('role' in u) ||
    typeof u.account !== 'string' ||
    typeof u.displayName !== 'string' ||
    typeof u.role !== 'string'
  ) {
    throw new Error('currentUser() 必須在 requireAuth 之後呼叫');
  }
  return { account: u.account, displayName: u.displayName, role: u.role };
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
  /** @type {SessionUser} */
  const user = { account: session.account, displayName: session.displayName, role: session.role };
  res.locals.user = user;
  next();
}

/**
 * 需為管理者（須接在 requireAuth 之後）。
 * @type {import('express').RequestHandler}
 */
export function requireAdmin(_req, res, next) {
  if (currentUser(res).role !== 'admin') {
    res.status(403).json({ message: FORBIDDEN_MESSAGE });
    return;
  }
  next();
}
