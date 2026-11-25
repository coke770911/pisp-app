// @ts-check
/**
 * 系統帳號（白名單）管理 API：僅管理者可用（掛載時接 requireAuth + requireAdmin）。
 * 保護規則：
 *  - 不可停用／刪除／降級自己 → 409
 *  - 不可讓啟用中的管理者變成 0 位 → 409
 * 以「行程內序列化 + 資料庫交易（SERIALIZABLE + 鎖定）」避免並發把管理者刪光。
 */
import { Router } from 'express';
import { Transaction, UniqueConstraintError } from 'sequelize';
import { z } from 'zod';
import { currentUser, revokeTokensByAccount } from '../middleware/auth.js';
import { SystemUser, USER_ROLES, normalizeAccount, sequelize } from '../models/index.js';
import { HttpError, parseInput } from '../utils/http.js';

const SELF_PROTECT_MESSAGE = '不可變更自己的帳號狀態或角色';
const LAST_ADMIN_MESSAGE = '至少需保留一位啟用中的管理者';
const NOT_FOUND_MESSAGE = '找不到此帳號';

const roleSchema = z.enum(USER_ROLES);

const createBodySchema = z.object({
  account: z
    .string()
    .transform((v) => normalizeAccount(v))
    .pipe(
      z
        .string()
        .min(1)
        .max(50)
        .regex(/^[A-Za-z0-9._-]+$/),
    ),
  role: roleSchema.default('user'),
});

const updateBodySchema = z.object({
  role: roleSchema.optional(),
  is_active: z.boolean().optional(),
});

const idParamSchema = z.object({ id: z.coerce.number().int().min(1) });

/**
 * @typedef {Object} SystemUserDto
 * @property {number} id
 * @property {string} account
 * @property {string | null} display_name
 * @property {string} role
 * @property {boolean} is_active
 * @property {string | null} created_by
 * @property {Date | null} last_login_at
 * @property {Date | undefined} createdAt
 */

/**
 * 轉成 API 回傳格式。
 * @param {import('../models/SystemUser.js').SystemUserInstance} row
 * @returns {SystemUserDto}
 */
function toDto(row) {
  const p = row.get({ plain: true });
  return {
    id: p.id,
    account: p.account,
    display_name: p.display_name,
    role: p.role,
    is_active: Boolean(p.is_active),
    created_by: p.created_by,
    last_login_at: p.last_login_at,
    createdAt: p.createdAt,
  };
}

/** 帳號管理寫入操作的行程內序列化（單一行程部署時可完全避免競態） */
let mutationQueue = Promise.resolve();

/**
 * 依序執行寫入操作：前一個完成（不論成敗）才開始下一個，並包在 SERIALIZABLE 交易中。
 * @template T
 * @param {(t: Transaction) => Promise<T>} work
 * @returns {Promise<T>}
 */
function serializedTransaction(work) {
  const run = mutationQueue.then(() =>
    sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, (t) => work(t)),
  );
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 計算啟用中管理者人數（交易內鎖定讀取）。
 * @param {Transaction} t
 * @returns {Promise<number>}
 */
async function countActiveAdmins(t) {
  const rows = await SystemUser.findAll({
    attributes: ['id'],
    where: { role: 'admin', is_active: true },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return rows.length;
}

/**
 * 交易內取得指定帳號（不存在 → 404）。
 * @param {number} id
 * @param {Transaction} t
 */
async function findUserOr404(id, t) {
  const row = await SystemUser.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!row) throw new HttpError(404, NOT_FOUND_MESSAGE);
  return row;
}

export const usersRouter = Router();

usersRouter.get('/', async (_req, res) => {
  const rows = await SystemUser.findAll({ order: [['account', 'ASC']] });
  res.json(rows.map(toDto));
});

usersRouter.post('/', async (req, res) => {
  const body = parseInput(createBodySchema, req.body, '帳號格式錯誤（1~50 字，僅限英數與 . _ -）');
  const me = currentUser(res);
  try {
    const created = await serializedTransaction(async (t) => {
      const existing = await SystemUser.findOne({ where: { account: body.account }, transaction: t });
      if (existing) throw new HttpError(409, '帳號已存在');
      return SystemUser.create(
        { account: body.account, role: body.role, is_active: true, created_by: me.account },
        { transaction: t },
      );
    });
    res.status(201).json(toDto(created));
  } catch (err) {
    // 唯一索引擋下的並發重複新增
    if (err instanceof UniqueConstraintError) throw new HttpError(409, '帳號已存在');
    throw err;
  }
});

usersRouter.put('/:id', async (req, res) => {
  const { id } = parseInput(idParamSchema, req.params);
  const body = parseInput(updateBodySchema, req.body);
  const me = currentUser(res);

  const result = await serializedTransaction(async (t) => {
    const row = await findUserOr404(id, t);
    // 注意：get({ plain: true }) 可能直接回傳 dataValues 參考，update 後會被改寫，故先複製一份
    const before = { ...row.get({ plain: true }) };
    const nextRole = body.role ?? before.role;
    const nextActive = body.is_active ?? Boolean(before.is_active);

    const wasActiveAdmin = before.role === 'admin' && Boolean(before.is_active);
    const willBeActiveAdmin = nextRole === 'admin' && nextActive;

    // 不可停用或降級自己（設成相同值則允許，視為無變更）
    if (before.account === me.account && wasActiveAdmin && !willBeActiveAdmin) {
      throw new HttpError(409, SELF_PROTECT_MESSAGE);
    }
    // 不可讓啟用中的管理者變成 0 位
    if (wasActiveAdmin && !willBeActiveAdmin && (await countActiveAdmins(t)) <= 1) {
      throw new HttpError(409, LAST_ADMIN_MESSAGE);
    }

    await row.update({ role: nextRole, is_active: nextActive }, { transaction: t });
    // 停用 → token_version +1，該帳號既有 JWT 全部失效（之後重新啟用也不會復活）。
    // 角色變更不需處理：每次請求的角色一律以資料庫為準。
    if (Boolean(before.is_active) && !nextActive) {
      await revokeTokensByAccount(before.account, t);
      await row.reload({ transaction: t });
    }
    return row;
  });

  res.json(toDto(result));
});

usersRouter.delete('/:id', async (req, res) => {
  const { id } = parseInput(idParamSchema, req.params);
  const me = currentUser(res);

  // 刪除後該帳號的 JWT 會因查無帳號而失效；即使日後以同名重建，也會取得新 id（JWT 內的 uid 不符）
  await serializedTransaction(async (t) => {
    const row = await findUserOr404(id, t);
    const before = row.get({ plain: true });
    if (before.account === me.account) throw new HttpError(409, SELF_PROTECT_MESSAGE);
    const isActiveAdmin = before.role === 'admin' && Boolean(before.is_active);
    if (isActiveAdmin && (await countActiveAdmins(t)) <= 1) throw new HttpError(409, LAST_ADMIN_MESSAGE);
    await row.destroy({ transaction: t });
  });

  res.json({ ok: true });
});
