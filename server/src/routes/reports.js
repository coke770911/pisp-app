// @ts-check
/**
 * 報表 API：拆帳報表下載。
 */
import { Router } from 'express';
import { loadBrackets } from './brackets.js';
import { loadMonthPayrolls } from '../services/payrollService.js';
import { buildSplitReport } from '../services/report.js';
import { HttpError, pad2, parseInput, sendXlsx, yearMonthSchema } from '../utils/http.js';

export const reportsRouter = Router();

reportsRouter.get('/split', async (req, res) => {
  const { year, month } = parseInput(yearMonthSchema, req.query, '請指定正確的年度與月份');
  const payrolls = await loadMonthPayrolls(year, month);
  if (payrolls.length === 0) throw new HttpError(404, `${year} 年 ${pad2(month)} 月沒有資料`);
  const brackets = await loadBrackets(year);
  // 勞健、公健（健保）都需要級距資料
  if (brackets.length === 0) {
    throw new HttpError(400, `${year} 年度尚無投保級距資料，請先匯入級距表`);
  }
  const bytes = await buildSplitReport(payrolls, brackets);
  sendXlsx(res, `拆帳報表_${year}年${pad2(month)}月.xlsx`, bytes);
});
