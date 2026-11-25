// @ts-check
/**
 * JWT 登入狀態與 requireAuth / requireAdmin 中介層。
 *
 * - Token：HS256 JWT，以 httpOnly + SameSite=Strict cookie `hisp_sid` 傳遞（前端 JS 無法讀取）。
 * - Payload：sub = 帳號、uid = system_users.id、tv = token_version、name = 顯示名稱、jti = 隨機 id。
 * - 每次請求除驗章與到期外，另查資料庫：帳號須存在、啟用、id 與 token_version 相符；
 *   角色一律以資料庫為準（升降級立即生效）。停用／刪除時 token_version +1，使既有 JWT 失效。
 * - 登出：將 jti 加入撤銷清單直到該 token 到期（記憶體；重啟後清單清空，但 cookie 已同時清除）。
 */
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { SystemUser } from '../models/index.js';

/** 登入 cookie 名稱 */
export const SESSION_COOKIE = 'hisp_sid';

/** 未登入或逾時的統一訊息 */
export const UNAUTHORIZED_MESSAGE = '登入逾時，請重新登入';

/** 非管理者存取管理功能的訊息 */
export const FORBIDDEN_MESSAGE = '權限不足';

/** JWT issuer / audience */
const JWT_ISSUER = 'hisp';
const JWT_AUDIENCE = 'hisp-web';
const JWT_ALG = 'HS256';

/** 登入有效毫秒數 */
export const SESSION_TTL_MS = Math.max(1, env.SESSION_TTL_HOURS) * 60 * 60 * 1000;

/** 簽章金鑰：未設定或過短時產生臨時金鑰並警告 */
const secretKey = (() => {
  if (env.JWT_SECRET.length >= 32) return new TextEncoder().encode(env.JWT_SECRET);
  console.warn(
    env.JWT_SECRET.length === 0
      ? '[auth] 未設定 JWT_SECRET，已產生臨時金鑰：伺服器重啟後所有人需重新登入。請在 .env 設定至少 32 字元的隨機值。'
      : '[auth] JWT_SECRET 少於 32 字元，已改用臨時金鑰。請在 .env 設定至少 32 字元的隨機值。',
  );
  return crypto.randomBytes(48);
})();

/**
 * @typedef {Object} SessionUser
 * @property {string} account      校內帳號（小寫）
 * @property {string} displayName  顯示名稱
 * @property {string} role         'admin' | 'user'（以資料庫為準）
 */

/** JWT payload 驗證 */
const payloadSchema = z.object({
  sub: z.string().min(1).max(50),
  uid: z.number().int().positive(),
  tv: z.number().int().nonnegative(),
  name: z.string().max(100),
  jti: z.string().regex(/^[0-9a-f]{32}$/),
  exp: z.number().int(),
});

/** 已登出的 jti → 到期時間（epoch ms） */
/** @type {Map<string, number>} */
const revokedJti = new Map();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of revokedJti) if (exp <= now) revokedJti.delete(jti);
}, 10 * 60 * 1000);
cleanupTimer.unref();

/**
 * 簽發登入 JWT。
 * @param {{ id: number, account: string, displayName: string, tokenVersion: number }} user
 * @returns {Promise<string>}
 */
export async function issueToken(user) {
  return new SignJWT({ uid: user.id, tv: user.tokenVersion, name: user.displayName })
    .setProtectedHeader({ alg: JWT_ALG, typ: 'JWT' })
    .setSubject(user.account)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setJti(crypto.randomBytes(16).toString('hex'))
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_TTL_MS) / 1000))
    .sign(secretKey);
}

/**
 * 驗證 JWT 簽章與內容（不查資料庫）。失敗回 null。
 * @param {unknown} token
 * @returns {Promise<z.infer<typeof payloadSchema> | null>}
 */
async function verifyToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: [JWT_ALG],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    if (revokedJti.has(parsed.data.jti)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * 從請求讀出 token。
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
 * 驗證請求的登入狀態（驗章 + 資料庫檢查）。未登入或失效回 null。
 * @param {import('express').Request} req
 * @returns {Promise<SessionUser | null>}
 */
export async function authenticate(req) {
  const p = await verifyToken(readSessionToken(req));
  if (!p) return null;
  const row = await SystemUser.findOne({ where: { account: p.sub } });
  const u = row?.get({ plain: true });
  if (!u || !u.is_active || u.id !== p.uid || u.token_version !== p.tv) return null;
  return { account: u.account, displayName: p.name || u.display_name || u.account, role: u.role };
}

/**
 * 登出：撤銷此 token 的 jti 直到到期。
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
export async function revokeRequestToken(req) {
  const p = await verifyToken(readSessionToken(req));
  if (p) revokedJti.set(p.jti, p.exp * 1000);
}

/**
 * 使某帳號既有的所有 JWT 失效（停用／刪除時呼叫，token_version +1）。
 * 帳號已刪除時不需處理（authenticate 查無帳號即拒絕；重建帳號會取得新 id）。
 * @param {string} account
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
export async function revokeTokensByAccount(account, transaction) {
  await SystemUser.increment('token_version', { by: 1, where: { account }, transaction });
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function requireAuth(req, res, next) {
  const user = await authenticate(req);
  if (!user) {
    res.status(401).json({ message: UNAUTHORIZED_MESSAGE });
    return;
  }
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
