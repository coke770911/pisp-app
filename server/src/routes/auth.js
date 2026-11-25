// @ts-check
/**
 * 認證 API：captcha / login / logout / me。
 * 帳密交由校內 portal API 驗證；能否使用本系統由 system_users 白名單決定。
 * 登入流程（依契約）：
 *  1. 速率限制（每 IP 每 15 分鐘 LOGIN_RATE_LIMIT）
 *  2. 先驗驗證碼（取出即刪除，一次性）
 *  3. 呼叫 portal 驗證帳密（無論帳號是否在白名單都呼叫，讓成本一致）
 *  4. portal 失敗或帳號不在白名單／已停用 → 一律 401 同訊息
 *  5. 所有失敗回應統一延遲到 LOGIN_MIN_DELAY_MS 下限
 *  6. 成功：更新 display_name、last_login_at，簽發 JWT（httpOnly cookie）
 */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  UNAUTHORIZED_MESSAGE,
  authenticate,
  issueToken,
  revokeRequestToken,
} from '../middleware/auth.js';
import { clientIp, createRateLimiter } from '../middleware/rateLimit.js';
import { SystemUser, normalizeAccount } from '../models/index.js';
import { consumeCaptcha, issueCaptcha } from '../services/captcha.js';
import { verifyWithPortal } from '../services/portalAuth.js';

const INVALID_CREDENTIALS = { message: '帳號或密碼錯誤，或無此系統使用權限', code: 'INVALID_CREDENTIALS' };
const CAPTCHA_INVALID = { message: '驗證碼錯誤或已過期', code: 'CAPTCHA_INVALID' };
const SERVICE_UNAVAILABLE = { message: '服務暫時無法使用' };

/** 驗證碼欄位（缺漏或格式錯誤皆視同驗證碼錯誤） */
const captchaFieldsSchema = z.object({
  captchaId: z.string().regex(/^[0-9a-f]{32}$/),
  captchaCode: z.string().regex(/^\d{4}$/),
});

/** 帳密欄位（格式錯誤視同帳密錯誤） */
const credentialsSchema = z.object({
  account: z
    .string()
    .transform((v) => normalizeAccount(v))
    .pipe(z.string().min(1).max(50)),
  password: z.string().min(1).max(200),
});

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Math.max(1, env.LOGIN_RATE_LIMIT),
  message: '嘗試次數過多，請稍後再試',
});

const captchaLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: Math.max(1, env.CAPTCHA_RATE_LIMIT),
  message: '請求過於頻繁，請稍後再試',
});

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 失敗回應：補足延遲到 LOGIN_MIN_DELAY_MS 下限後再送出。
 * @param {import('express').Response} res
 * @param {number} startedAt
 * @param {number} status
 * @param {Record<string, string>} body
 * @returns {Promise<void>}
 */
async function failAfterDelay(res, startedAt, status, body) {
  const remaining = env.LOGIN_MIN_DELAY_MS - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
  res.status(status).json(body);
}

/**
 * Session cookie 選項。
 * @returns {import('express').CookieOptions}
 */
function cookieOptions() {
  return { httpOnly: true, sameSite: 'strict', secure: env.COOKIE_SECURE, path: '/' };
}

export const authRouter = Router();

authRouter.get('/captcha', captchaLimiter.middleware, (_req, res) => {
  const { captchaId, image } = issueCaptcha();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ captchaId, image });
});

authRouter.post('/login', loginLimiter.middleware, async (req, res) => {
  const startedAt = Date.now();
  /** @type {unknown} */
  const body = req.body ?? {};

  // 2. 先驗驗證碼（取出即刪除）
  const cap = captchaFieldsSchema.safeParse(body);
  if (!cap.success) {
    // 有帶 captchaId 也要作廢，避免格式錯誤的 code 讓同一 id 可重試
    if (typeof body === 'object' && body !== null && 'captchaId' in body) consumeCaptcha(body.captchaId, '');
    await failAfterDelay(res, startedAt, 400, CAPTCHA_INVALID);
    return;
  }
  if (!consumeCaptcha(cap.data.captchaId, cap.data.captchaCode)) {
    await failAfterDelay(res, startedAt, 400, CAPTCHA_INVALID);
    return;
  }

  const cred = credentialsSchema.safeParse(body);
  if (!cred.success) {
    await failAfterDelay(res, startedAt, 401, INVALID_CREDENTIALS);
    return;
  }
  const { account, password } = cred.data;

  // 3. 無論是否在白名單都呼叫 portal
  const portal = await verifyWithPortal(account, password);
  if (portal.kind === 'unavailable') {
    await failAfterDelay(res, startedAt, 503, SERVICE_UNAVAILABLE);
    return;
  }

  // 4. portal 失敗或非白名單／停用 → 一律 401 同訊息
  const user = await SystemUser.findOne({ where: { account } });
  const u = user?.get({ plain: true });
  if (portal.kind !== 'ok' || !user || !u || !u.is_active) {
    await failAfterDelay(res, startedAt, 401, INVALID_CREDENTIALS);
    return;
  }

  // 6. 成功：更新顯示名稱與最後登入時間
  const displayName = portal.displayName || u.display_name || u.account;
  await user.update({ display_name: portal.displayName || u.display_name, last_login_at: new Date() });

  // 舊 token 撤銷、清除此 IP 的嘗試計數
  await revokeRequestToken(req);
  loginLimiter.reset(clientIp(req));
  const token = await issueToken({ id: u.id, account: u.account, displayName, tokenVersion: u.token_version });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
  res.json({ account: u.account, displayName, role: u.role });
});

authRouter.post('/logout', async (req, res) => {
  await revokeRequestToken(req);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true });
});

authRouter.get('/me', async (req, res) => {
  const user = await authenticate(req);
  if (!user) {
    res.status(401).json({ message: UNAUTHORIZED_MESSAGE });
    return;
  }
  res.json({ account: user.account, displayName: user.displayName, role: user.role });
});
