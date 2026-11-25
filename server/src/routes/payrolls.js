// @ts-check
/**
 * 月度投保資料 API（月份清單、查詢、匯入、匯出、編輯、確認／重新開啟）。
 * 注意路由順序：/months、/export、/import、/confirm、/reopen 必須在 /:id 之前。
 */
import { Router } from 'express';
import { Op, UniqueConstraintError } from 'sequelize';
import { z } from 'zod';
import { MonthlyPayroll, MonthlyPayrollItem, PAYROLL_STATUS, normalizeIdNumber, sequelize } from '../models/index.js';
import { uploadXlsx } from '../middleware/upload.js';
import { buildPayrollWorkbook, parsePayrollWorkbook } from '../services/excel.js';
import { deleteMonth, getMonthStatus, loadMonthPayrolls, loadPayrollById } from '../services/payrollService.js';
import { HttpError, pad2, parseInput, sendXlsx, yearMonthSchema } from '../utils/http.js';
import { PENSION_RATE_MAX, PENSION_RATE_MIN } from '../../../shared/splitCalc.js';

const CONFIRMED_MESSAGE = '該月份已確認，無法修改；如需修改請先重新開啟';
const BUSY_MESSAGE = '資料正在由其他操作處理中，請稍後重試';
const DUP_ID_NUMBER_MESSAGE = '本月已有此身分證號的人員';
const DUP_EMPLOYEE_NO_MESSAGE = '職員編號已被其他人員使用';

const yearMonthBodySchema = z.object({
  year: z.number().int().min(1).max(999),
  month: z.number().int().min(1).max(12),
});
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const intAmount = z.number().int().min(-2_000_000_000).max(2_000_000_000);
/** 勞退自提率（%）：0~6 整數 */
const pensionRateSchema = z.number().int().min(PENSION_RATE_MIN).max(PENSION_RATE_MAX);
/** 職員編號：必填、≤ 20（可修改，同月不得與他人重複） */
const employeeNoSchema = z.string().trim().min(1).max(20);
/** 身分證號：必填、trim + 大寫、≤ 20（人員識別鍵） */
const idNumberSchema = z
  .string()
  .transform((s) => normalizeIdNumber(s))
  .pipe(z.string().min(1).max(20));
/** PUT 可修改欄位（身分證號為識別鍵不可修改；body 帶了也會被忽略） */
const updateSchema = z.object({
  employee_no: employeeNoSchema,
  name: z.string().trim().max(50),
  birthday: z.string().trim().max(20),
  base_salary: intAmount,
  insurance_type: z.union([z.literal('勞健'), z.literal('公健')]),
  // PUT 未帶時保留原值
  pension_rate: pensionRateSchema.optional(),
  items: z
    .array(
      z.object({
        source_name: z.string().trim().min(1).max(50),
        amount: intAmount,
      }),
    )
    .max(500),
});
const createSchema = updateSchema.extend({
  year: z.number().int().min(1).max(999),
  month: z.number().int().min(1).max(12),
  id_number: idNumberSchema,
  // POST 未帶時為 0
  pension_rate: pensionRateSchema.default(0),
});
const copySchema = z.object({
  fromYear: z.number().int().min(1).max(999),
  fromMonth: z.number().int().min(1).max(12),
  toYear: z.number().int().min(1).max(999),
  toMonth: z.number().int().min(1).max(12),
  overwrite: z.boolean().optional(),
});

/**
 * @typedef {Object} PersonInput
 * @property {string} employee_no
 * @property {string} name
 * @property {string} id_number
 * @property {string} birthday
 * @property {string} insurance_type
 * @property {number} base_salary
 * @property {number} pension_rate  勞退自提率（%，0~6）
 * @property {number} source_order
 * @property {ReadonlyArray<{ source_name: string, amount: number }>} items
 */

/**
 * 在交易內寫入多位人員與其加項（status 一律 draft）。
 * @param {number} year
 * @param {number} month
 * @param {ReadonlyArray<PersonInput>} persons
 * @param {import('sequelize').Transaction} t
 * @returns {Promise<void>}
 */
async function insertPersons(year, month, persons, t) {
  if (persons.length === 0) return;
  /** @type {{ payroll_id: number, source_name: string, amount: number, sort_order: number }[]} */
  const items = [];
  // 逐筆建立以直接取得 id（不依賴 bulkCreate 回傳 id，也不以業務鍵回查對應，
  // 避免舊資料庫尚有重複身分證號時加項對錯人）
  for (const p of persons) {
    const row = await MonthlyPayroll.create(
      {
        roc_year: year,
        month,
        employee_no: p.employee_no,
        name: p.name,
        id_number: normalizeIdNumber(p.id_number),
        birthday: p.birthday,
        insurance_type: p.insurance_type,
        base_salary: p.base_salary,
        pension_rate: p.pension_rate,
        status: PAYROLL_STATUS.DRAFT,
        source_order: p.source_order,
      },
      { transaction: t },
    );
    const payrollId = row.get({ plain: true }).id;
    p.items.forEach((it, i) => {
      items.push({ payroll_id: payrollId, source_name: it.source_name, amount: it.amount, sort_order: i + 1 });
    });
  }
  if (items.length > 0) await MonthlyPayrollItem.bulkCreate(items, { transaction: t });
}

/**
 * 唯一約束衝突 → 409。
 * @param {string} message
 * @returns {(err: unknown) => never}
 */
function rethrowUnique(message) {
  return (err) => {
    if (err instanceof UniqueConstraintError) throw new HttpError(409, message);
    throw err;
  };
}

/**
 * @typedef {Object} MonthSummary
 * @property {number} roc_year
 * @property {number} month
 * @property {'draft' | 'confirmed'} status
 * @property {number} count
 */

const groupRowSchema = z.object({
  roc_year: z.coerce.number().int(),
  month: z.coerce.number().int(),
  status: z.string(),
  count: z.coerce.number().int(),
});

export const payrollsRouter = Router();

payrollsRouter.get('/months', async (_req, res) => {
  const groups = await MonthlyPayroll.count({ group: ['roc_year', 'month', 'status'] });
  /** @type {Map<string, MonthSummary>} */
  const map = new Map();
  for (const g of groups) {
    const row = groupRowSchema.parse(g);
    const key = `${row.roc_year}-${row.month}`;
    const cur = map.get(key) ?? { roc_year: row.roc_year, month: row.month, status: 'draft', count: 0 };
    cur.count += row.count;
    if (row.status === PAYROLL_STATUS.CONFIRMED) cur.status = 'confirmed';
    map.set(key, cur);
  }
  const list = [...map.values()].sort((a, b) => b.roc_year - a.roc_year || b.month - a.month);
  res.json(list);
});

payrollsRouter.get('/export', async (req, res) => {
  const { year, month } = parseInput(yearMonthSchema, req.query, '請指定正確的年度與月份');
  const payrolls = await loadMonthPayrolls(year, month);
  if (payrolls.length === 0) throw new HttpError(404, `${year} 年 ${pad2(month)} 月沒有資料`);
  const bytes = await buildPayrollWorkbook(payrolls);
  sendXlsx(res, `個人所得明細_${year}年${pad2(month)}月.xlsx`, bytes);
});

payrollsRouter.post('/import', uploadXlsx, async (req, res) => {
  const { year, month } = parseInput(yearMonthSchema, req.body, '請指定正確的年度與月份');
  const file = /** @type {Express.Multer.File} */ (req.file);
  const { persons, warnings } = await parsePayrollWorkbook(file.buffer, year, month);

  await sequelize
    .transaction(async (t) => {
      if ((await getMonthStatus(year, month, t)) === 'confirmed') throw new HttpError(409, CONFIRMED_MESSAGE);
      await deleteMonth(year, month, t);
      await insertPersons(year, month, persons, t);
    })
    .catch(rethrowUnique(BUSY_MESSAGE));

  const laborCount = persons.filter((p) => p.insurance_type === '勞健').length;
  res.json({ year, month, count: persons.length, laborCount, publicCount: persons.length - laborCount, warnings });
});

payrollsRouter.post('/copy', async (req, res) => {
  const body = parseInput(copySchema, req.body, '請指定正確的來源與目標年月');
  if (body.fromYear === body.toYear && body.fromMonth === body.toMonth) {
    throw new HttpError(400, '來源月份與目標月份不可相同');
  }
  const count = await sequelize
    .transaction(async (t) => {
      const targetStatus = await getMonthStatus(body.toYear, body.toMonth, t);
      if (targetStatus === 'confirmed') throw new HttpError(409, CONFIRMED_MESSAGE);
      if (targetStatus === 'draft' && body.overwrite !== true) throw new HttpError(409, '目標月份已有資料');
      const source = await loadMonthPayrolls(body.fromYear, body.fromMonth, t);
      if (source.length === 0) throw new HttpError(404, `${body.fromYear} 年 ${pad2(body.fromMonth)} 月沒有資料`);
      await deleteMonth(body.toYear, body.toMonth, t);
      await insertPersons(body.toYear, body.toMonth, source, t);
      return source.length;
    })
    .catch(rethrowUnique(BUSY_MESSAGE));
  res.json({ year: body.toYear, month: body.toMonth, count });
});

payrollsRouter.post('/confirm', async (req, res) => {
  const { year, month } = parseInput(yearMonthBodySchema, req.body, '請指定正確的年度與月份');
  await sequelize.transaction(async (t) => {
    const total = await MonthlyPayroll.count({ where: { roc_year: year, month }, transaction: t });
    if (total === 0) throw new HttpError(404, `${year} 年 ${pad2(month)} 月沒有資料`);
    // 條件更新：只有 draft 會被改成 confirmed，重複呼叫不會有副作用
    await MonthlyPayroll.update(
      { status: PAYROLL_STATUS.CONFIRMED },
      { where: { roc_year: year, month, status: PAYROLL_STATUS.DRAFT }, transaction: t },
    );
  });
  res.json({ status: 'confirmed' });
});

payrollsRouter.post('/reopen', async (req, res) => {
  const { year, month } = parseInput(yearMonthBodySchema, req.body, '請指定正確的年度與月份');
  await sequelize.transaction(async (t) => {
    const total = await MonthlyPayroll.count({ where: { roc_year: year, month }, transaction: t });
    if (total === 0) throw new HttpError(404, `${year} 年 ${pad2(month)} 月沒有資料`);
    await MonthlyPayroll.update(
      { status: PAYROLL_STATUS.DRAFT },
      { where: { roc_year: year, month, status: PAYROLL_STATUS.CONFIRMED }, transaction: t },
    );
  });
  res.json({ status: 'draft' });
});

payrollsRouter.get('/', async (req, res) => {
  const { year, month } = parseInput(yearMonthSchema, req.query, '請指定正確的年度與月份');
  const payrolls = await loadMonthPayrolls(year, month);
  const status = payrolls.length === 0 ? 'none' : payrolls.some((p) => p.status === PAYROLL_STATUS.CONFIRMED) ? 'confirmed' : 'draft';
  res.json({ year, month, status, payrolls });
});

/**
 * 刪除整月明細（以便重新匯入）。已確認的月份需先重新開啟 → 409。
 * 無資料 → 404。交易內先查狀態再刪，避免與確認操作競態。
 */
payrollsRouter.delete('/', async (req, res) => {
  const { year, month } = parseInput(yearMonthSchema, req.query, '請指定正確的年度與月份');
  const deleted = await sequelize.transaction(async (t) => {
    const total = await MonthlyPayroll.count({ where: { roc_year: year, month }, transaction: t });
    if (total === 0) throw new HttpError(404, `${year} 年 ${pad2(month)} 月沒有資料`);
    if ((await getMonthStatus(year, month, t)) === 'confirmed') throw new HttpError(409, CONFIRMED_MESSAGE);
    await deleteMonth(year, month, t);
    return total;
  });
  res.json({ year, month, deleted });
});

payrollsRouter.post('/', async (req, res) => {
  const data = parseInput(
    createSchema,
    req.body,
    '輸入資料格式錯誤：職員編號與身分證號必填（20 字內）、本薪與金額必須為整數、勞退自提須為 0~6 的整數',
  );
  const created = await sequelize
    .transaction(async (t) => {
      if ((await getMonthStatus(data.year, data.month, t)) === 'confirmed') throw new HttpError(409, CONFIRMED_MESSAGE);
      const dupId = await MonthlyPayroll.count({
        where: { roc_year: data.year, month: data.month, id_number: data.id_number },
        transaction: t,
      });
      if (dupId > 0) throw new HttpError(409, DUP_ID_NUMBER_MESSAGE);
      const dupEmp = await MonthlyPayroll.count({
        where: { roc_year: data.year, month: data.month, employee_no: data.employee_no },
        transaction: t,
      });
      if (dupEmp > 0) throw new HttpError(409, DUP_EMPLOYEE_NO_MESSAGE);
      const last = await MonthlyPayroll.findOne({
        where: { roc_year: data.year, month: data.month },
        order: [['source_order', 'DESC']],
        attributes: ['source_order'],
        transaction: t,
      });
      const row = await MonthlyPayroll.create(
        {
          roc_year: data.year,
          month: data.month,
          employee_no: data.employee_no,
          name: data.name,
          id_number: data.id_number,
          birthday: data.birthday,
          insurance_type: data.insurance_type,
          base_salary: data.base_salary,
          pension_rate: data.pension_rate,
          status: PAYROLL_STATUS.DRAFT,
          source_order: (last ? last.get({ plain: true }).source_order : 0) + 1,
        },
        { transaction: t },
      );
      const id = row.get({ plain: true }).id;
      if (data.items.length > 0) {
        await MonthlyPayrollItem.bulkCreate(
          data.items.map((it, i) => ({ payroll_id: id, source_name: it.source_name, amount: it.amount, sort_order: i + 1 })),
          { transaction: t },
        );
      }
      return loadPayrollById(id, t);
    })
    // 併發下撞唯一索引 (roc_year, month, id_number) 仍回 409
    .catch(rethrowUnique(DUP_ID_NUMBER_MESSAGE));
  res.status(201).json(created);
});

payrollsRouter.delete('/:id', async (req, res) => {
  const { id } = parseInput(idParamSchema, req.params, '無效的人員編號');
  await sequelize.transaction(async (t) => {
    const row = await MonthlyPayroll.findByPk(id, { transaction: t });
    if (!row) throw new HttpError(404, '找不到此人員資料');
    if ((await getMonthStatus(row.get({ plain: true }).roc_year, row.get({ plain: true }).month, t)) === 'confirmed') {
      throw new HttpError(409, CONFIRMED_MESSAGE);
    }
    await MonthlyPayrollItem.destroy({ where: { payroll_id: id }, transaction: t });
    // 條件刪除：僅限 draft
    const deleted = await MonthlyPayroll.destroy({ where: { id, status: PAYROLL_STATUS.DRAFT }, transaction: t });
    if (deleted === 0) throw new HttpError(409, CONFIRMED_MESSAGE);
  });
  res.json({ ok: true });
});

payrollsRouter.put('/:id', async (req, res) => {
  const { id } = parseInput(idParamSchema, req.params, '無效的人員編號');
  // updateSchema 不含 id_number：身分證號為識別鍵不可修改，body 帶了也會被 zod 剔除
  const data = parseInput(
    updateSchema,
    req.body,
    '輸入資料格式錯誤：職員編號必填（20 字內），本薪與金額必須為整數，薪資來源為必填（50 字內），勞退自提須為 0~6 的整數',
  );

  const updated = await sequelize.transaction(async (t) => {
    const row = await MonthlyPayroll.findByPk(id, { transaction: t });
    if (!row) throw new HttpError(404, '找不到此人員資料');
    const current = row.get({ plain: true });
    const status = await getMonthStatus(current.roc_year, current.month, t);
    if (status === 'confirmed') throw new HttpError(409, CONFIRMED_MESSAGE);

    // 職員編號可修改，但同月不得與他人重複（應用層檢查）
    if (data.employee_no !== current.employee_no) {
      const dupEmp = await MonthlyPayroll.count({
        where: { roc_year: current.roc_year, month: current.month, employee_no: data.employee_no, id: { [Op.ne]: id } },
        transaction: t,
      });
      if (dupEmp > 0) throw new HttpError(409, DUP_EMPLOYEE_NO_MESSAGE);
    }

    // 條件更新：僅限 draft 狀態；pension_rate 未帶時不更新（保留原值）；id_number 不更新
    const [affected] = await MonthlyPayroll.update(
      {
        employee_no: data.employee_no,
        name: data.name,
        birthday: data.birthday,
        base_salary: data.base_salary,
        insurance_type: data.insurance_type,
        ...(data.pension_rate === undefined ? {} : { pension_rate: data.pension_rate }),
      },
      { where: { id, status: { [Op.eq]: PAYROLL_STATUS.DRAFT } }, transaction: t },
    );
    if (affected === 0) throw new HttpError(409, CONFIRMED_MESSAGE);

    await MonthlyPayrollItem.destroy({ where: { payroll_id: id }, transaction: t });
    if (data.items.length > 0) {
      await MonthlyPayrollItem.bulkCreate(
        data.items.map((it, i) => ({ payroll_id: id, source_name: it.source_name, amount: it.amount, sort_order: i + 1 })),
        { transaction: t },
      );
    }
    return loadPayrollById(id, t);
  }).catch(rethrowUnique(BUSY_MESSAGE));
  res.json(updated);
});
