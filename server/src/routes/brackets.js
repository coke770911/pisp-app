// @ts-check
/**
 * 投保級距表 API（年度清單、查詢、匯入、匯出、單列維護、複製年度）。
 * 注意路由順序：/years、/export、/copy、/import 必須在 /:id 之前。
 */
import { Router } from 'express';
import { Op, UniqueConstraintError } from 'sequelize';
import { z } from 'zod';
import { InsuranceBracket, sequelize } from '../models/index.js';
import { uploadXlsx } from '../middleware/upload.js';
import { buildBracketWorkbook, parseBracketWorkbook } from '../services/excel.js';
import { HttpError, parseInput, sendXlsx, yearQuerySchema, yearSchema } from '../utils/http.js';

const DUPLICATE_LIMIT_MESSAGE = '該年度已有相同月投保金額';

/**
 * @typedef {Object} BracketDto
 * @property {number} id
 * @property {number} roc_year
 * @property {number} salary_limit
 * @property {number} labor_emp
 * @property {number} labor_school
 * @property {number} labor_occupational
 * @property {number} pension_school
 * @property {number} health_emp
 * @property {number} health_school
 */

const nonNegInt = z.coerce.number().int().min(0).max(2_000_000_000);

/** 單列費用欄位（不含 roc_year） */
const bracketFieldsSchema = z.object({
  salary_limit: nonNegInt,
  labor_emp: nonNegInt,
  labor_school: nonNegInt,
  labor_occupational: nonNegInt,
  pension_school: nonNegInt,
  health_emp: nonNegInt,
  health_school: nonNegInt,
});
const bracketCreateSchema = bracketFieldsSchema.extend({ roc_year: yearSchema });
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const copySchema = z.object({ fromYear: yearSchema, toYear: yearSchema });

/**
 * @param {import('../models/InsuranceBracket.js').BracketInstance} row
 * @returns {BracketDto}
 */
function toDto(row) {
  const b = row.get({ plain: true });
  return {
    id: b.id,
    roc_year: b.roc_year,
    salary_limit: b.salary_limit,
    labor_emp: b.labor_emp,
    labor_school: b.labor_school,
    labor_occupational: b.labor_occupational,
    pension_school: b.pension_school,
    health_emp: b.health_emp,
    health_school: b.health_school,
  };
}

/**
 * 取得某年度全部級距（依 salary_limit 遞增）。
 * @param {number} year
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<BracketDto[]>}
 */
export async function loadBrackets(year, transaction) {
  const rows = await InsuranceBracket.findAll({
    where: { roc_year: year },
    order: [['salary_limit', 'ASC']],
    transaction,
  });
  return rows.map(toDto);
}

/**
 * 將唯一約束衝突轉為 409。
 * @param {unknown} err
 * @returns {never}
 */
function rethrowUnique(err) {
  if (err instanceof UniqueConstraintError) throw new HttpError(409, DUPLICATE_LIMIT_MESSAGE);
  throw err;
}

export const bracketsRouter = Router();

bracketsRouter.get('/years', async (_req, res) => {
  const groups = await InsuranceBracket.count({ group: ['roc_year'] });
  const years = groups
    .map((g) => Number(g.roc_year))
    .filter((y) => Number.isInteger(y))
    .sort((a, b) => b - a);
  res.json(years);
});

bracketsRouter.get('/export', async (req, res) => {
  const { year } = parseInput(yearQuerySchema, req.query, '請指定正確的年度');
  const brackets = await loadBrackets(year);
  if (brackets.length === 0) throw new HttpError(404, `${year} 年度沒有級距資料`);
  const bytes = await buildBracketWorkbook(brackets);
  sendXlsx(res, `勞健保級距表_${year}年.xlsx`, bytes);
});

bracketsRouter.post('/copy', async (req, res) => {
  const { fromYear, toYear } = parseInput(copySchema, req.body, '請指定正確的來源與目標年度');
  if (fromYear === toYear) throw new HttpError(400, '來源年度與目標年度不可相同');
  const count = await sequelize
    .transaction(async (t) => {
      const existing = await InsuranceBracket.count({ where: { roc_year: toYear }, transaction: t });
      if (existing > 0) throw new HttpError(409, `${toYear} 年度已有級距資料，請先刪除`);
      const source = await loadBrackets(fromYear, t);
      if (source.length === 0) throw new HttpError(404, `${fromYear} 年度沒有級距資料`);
      await InsuranceBracket.bulkCreate(
        source.map(({ id: _id, ...rest }) => ({ ...rest, roc_year: toYear })),
        { transaction: t },
      );
      return source.length;
    })
    .catch(rethrowUnique);
  res.json({ year: toYear, count });
});

bracketsRouter.post('/import', uploadXlsx, async (req, res) => {
  const { year } = parseInput(yearQuerySchema, req.body, '請指定正確的年度');
  const file = /** @type {Express.Multer.File} */ (req.file);
  const parsed = await parseBracketWorkbook(file.buffer);
  await sequelize
    .transaction(async (t) => {
      await InsuranceBracket.destroy({ where: { roc_year: year }, transaction: t });
      await InsuranceBracket.bulkCreate(
        parsed.map((b) => ({ ...b, roc_year: year })),
        { transaction: t },
      );
    })
    .catch(rethrowUnique);
  res.json({ year, count: parsed.length });
});

bracketsRouter.get('/', async (req, res) => {
  const { year } = parseInput(yearQuerySchema, req.query, '請指定正確的年度');
  res.json(await loadBrackets(year));
});

bracketsRouter.delete('/', async (req, res) => {
  const { year } = parseInput(yearQuerySchema, req.query, '請指定正確的年度');
  const deleted = await sequelize.transaction((t) => InsuranceBracket.destroy({ where: { roc_year: year }, transaction: t }));
  res.json({ year, deleted });
});

bracketsRouter.post('/', async (req, res) => {
  const data = parseInput(bracketCreateSchema, req.body, '級距欄位必須為非負整數');
  const created = await sequelize
    .transaction(async (t) => {
      const dup = await InsuranceBracket.count({
        where: { roc_year: data.roc_year, salary_limit: data.salary_limit },
        transaction: t,
      });
      if (dup > 0) throw new HttpError(409, DUPLICATE_LIMIT_MESSAGE);
      return InsuranceBracket.create(data, { transaction: t });
    })
    .catch(rethrowUnique);
  res.status(201).json(toDto(created));
});

bracketsRouter.put('/:id', async (req, res) => {
  const { id } = parseInput(idParamSchema, req.params, '無效的級距編號');
  const data = parseInput(bracketFieldsSchema, req.body, '級距欄位必須為非負整數');
  const updated = await sequelize
    .transaction(async (t) => {
      const row = await InsuranceBracket.findByPk(id, { transaction: t });
      if (!row) throw new HttpError(404, '找不到此級距資料');
      const dup = await InsuranceBracket.count({
        where: { roc_year: row.get({ plain: true }).roc_year, salary_limit: data.salary_limit, id: { [Op.ne]: id } },
        transaction: t,
      });
      if (dup > 0) throw new HttpError(409, DUPLICATE_LIMIT_MESSAGE);
      // roc_year 不可修改：只更新費用欄位
      await row.update(data, { transaction: t });
      return row;
    })
    .catch(rethrowUnique);
  res.json(toDto(updated));
});

bracketsRouter.delete('/:id', async (req, res) => {
  const { id } = parseInput(idParamSchema, req.params, '無效的級距編號');
  const deleted = await sequelize.transaction((t) => InsuranceBracket.destroy({ where: { id }, transaction: t }));
  if (deleted === 0) throw new HttpError(404, '找不到此級距資料');
  res.json({ ok: true });
});
