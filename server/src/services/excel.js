// @ts-check
/**
 * Excel 解析與輸出（級距表、個人所得明細）。
 */
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { HttpError, pad2 } from '../utils/http.js';
import { PENSION_RATE_MAX, PENSION_RATE_MIN, baseSourceName, mergePensionRates } from '../../../shared/splitCalc.js';

/** 錯誤訊息最多列出幾項 */
const MAX_ERRORS_SHOWN = 5;
/** 掃描表頭的最大列數 */
const HEADER_SCAN_ROWS = 10;

// ───────────────────────── 共用工具 ─────────────────────────

/**
 * 將任一儲存格值轉成字串（去除前後空白）。
 * @param {ExcelJS.CellValue} value
 * @returns {string}
 */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if ('richText' in value) return value.richText.map((t) => t.text).join('').trim();
  if ('formula' in value || 'sharedFormula' in value) {
    const result = value.result;
    if (result === undefined || result === null) return '';
    if (typeof result === 'object' && !(result instanceof Date)) return '';
    return cellText(result);
  }
  if ('text' in value && typeof value.text === 'string') return value.text.trim();
  return '';
}

/**
 * 表頭正規化：移除所有空白與換行、全形括號與連字號轉半形；
 * 「身份」視同「身分」（舊檔表頭「身份證號」仍可匯入，系統統一用「身分證號」）。
 * @param {string} s
 * @returns {string}
 */
export function normalizeHeader(s) {
  return s
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[－—–]/g, '-')
    .replace(/身份/g, '身分');
}

/**
 * 儲存格轉整數；空白回 null，無法轉換回 NaN。
 * 支援 number 與含千分位逗號的字串。
 * @param {ExcelJS.CellValue} value
 * @returns {number | null}
 */
export function cellInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : Number.NaN;
  const text = cellText(value).replace(/[,，\s]/g, '');
  if (text === '') return null;
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Math.round(Number(text));
}

/**
 * 讀取 xlsx Buffer。
 * @param {Buffer} buffer
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs 型別宣告的 Buffer 與 Node Buffer 不同，以 ArrayBuffer 傳入
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    await wb.xlsx.load(/** @type {ArrayBuffer} */ (ab));
  } catch (err) {
    console.error('[excel] 讀取失敗', err);
    throw new HttpError(400, '無法讀取 Excel 檔案，請確認為有效的 .xlsx 檔');
  }
  return wb;
}

/**
 * 在活頁簿中尋找含有全部必要表頭的工作表與表頭列。
 * 選填欄位（optionalKeys）找不到也可以，找到時一併記入 columns。
 * @template {string} K
 * @param {ExcelJS.Workbook} wb
 * @param {Readonly<Record<string, K>>} headerMap 正規化表頭 → 欄位鍵
 * @param {ReadonlyArray<K>} [optionalKeys] 選填欄位鍵
 * @returns {{ sheet: ExcelJS.Worksheet, headerRow: number, columns: Map<K, number> }}
 */
function locateHeader(wb, headerMap, optionalKeys = []) {
  const required = Object.keys(headerMap).filter((h) => !optionalKeys.includes(headerMap[h]));
  /** @type {string[]} */
  let bestMissing = required;
  for (const sheet of wb.worksheets) {
    const lastRow = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
    for (let r = 1; r <= lastRow; r++) {
      /** @type {Map<K, number>} */
      const columns = new Map();
      sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        const key = headerMap[normalizeHeader(cellText(cell.value))];
        if (key !== undefined && !columns.has(key)) columns.set(key, col);
      });
      const missing = required.filter((h) => !columns.has(/** @type {K} */ (headerMap[h])));
      if (missing.length === 0) return { sheet, headerRow: r, columns };
      if (missing.length < bestMissing.length) bestMissing = missing;
    }
  }
  throw new HttpError(400, `找不到必要的表頭欄位：${bestMissing.join('、')}`);
}

/**
 * 整列是否全為空白。
 * @param {ExcelJS.Row} row
 * @param {Iterable<number>} cols
 * @returns {boolean}
 */
function isEmptyRow(row, cols) {
  for (const c of cols) if (cellText(row.getCell(c).value) !== '') return false;
  return true;
}

/**
 * 有錯誤時丟出 400（列出前幾項）。
 * @param {string[]} errors
 */
function throwIfErrors(errors) {
  if (errors.length === 0) return;
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).join('；');
  const more = errors.length > MAX_ERRORS_SHOWN ? `…等共 ${errors.length} 項錯誤` : '';
  throw new HttpError(400, `檔案內容有誤：${shown}${more}`);
}

/**
 * 列號清單轉文字（過多時截斷）。
 * @param {ReadonlyArray<number>} rowNos
 * @returns {string}
 */
function formatRowNos(rowNos) {
  const max = 10;
  const shown = rowNos.slice(0, max).join('、');
  return rowNos.length > max ? `${shown}…等 ${rowNos.length} 列` : shown;
}

/**
 * 設定表頭樣式、凍結首列。
 * @param {ExcelJS.Worksheet} ws
 */
export function styleHeader(ws) {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/**
 * 活頁簿輸出為位元組。
 * @param {ExcelJS.Workbook} wb
 * @returns {Promise<Uint8Array>}
 */
export async function workbookToBytes(wb) {
  const out = await wb.xlsx.writeBuffer();
  return new Uint8Array(out);
}

// ───────────────────────── 級距表 ─────────────────────────

/** @typedef {'salary_limit' | 'labor_emp' | 'labor_school' | 'labor_occupational' | 'pension_school' | 'health_emp' | 'health_school'} BracketKey */

/** @type {Readonly<Record<string, BracketKey>>} */
const BRACKET_HEADERS = Object.freeze({
  [normalizeHeader('月投保金額')]: 'salary_limit',
  [normalizeHeader('勞保費個人')]: 'labor_emp',
  [normalizeHeader('勞保費學校(不含職災)')]: 'labor_school',
  [normalizeHeader('勞保費學校-職災')]: 'labor_occupational',
  [normalizeHeader('勞退金-學校')]: 'pension_school',
  [normalizeHeader('健保費-個人')]: 'health_emp',
  [normalizeHeader('健保費-學校')]: 'health_school',
});

const bracketRowSchema = z.object({
  salary_limit: z.number().int().positive(),
  labor_emp: z.number().int().min(0),
  labor_school: z.number().int().min(0),
  labor_occupational: z.number().int().min(0),
  pension_school: z.number().int().min(0),
  health_emp: z.number().int().min(0),
  health_school: z.number().int().min(0),
});

/** @typedef {z.infer<typeof bracketRowSchema>} ParsedBracket */

/**
 * 解析級距表 xlsx。
 * @param {Buffer} buffer
 * @returns {Promise<ParsedBracket[]>}
 */
export async function parseBracketWorkbook(buffer) {
  const wb = await loadWorkbook(buffer);
  const { sheet, headerRow, columns } = locateHeader(wb, BRACKET_HEADERS);

  /** @type {ParsedBracket[]} */
  const result = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {Set<number>} */
  const seen = new Set();

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (isEmptyRow(row, columns.values())) continue;

    /** @type {Record<string, number | null>} */
    const raw = {};
    for (const [key, col] of columns) raw[key] = cellInt(row.getCell(col).value);
    const parsed = bracketRowSchema.safeParse(raw);
    if (!parsed.success) {
      const bad = parsed.error.issues.map((i) => String(i.path[0])).filter((v, i, a) => a.indexOf(v) === i);
      errors.push(`第 ${r} 列數值格式錯誤（${bad.join('、')}）`);
      continue;
    }
    if (seen.has(parsed.data.salary_limit)) {
      errors.push(`第 ${r} 列月投保金額 ${parsed.data.salary_limit} 重複`);
      continue;
    }
    seen.add(parsed.data.salary_limit);
    result.push(parsed.data);
  }

  throwIfErrors(errors);
  if (result.length === 0) throw new HttpError(400, '級距表沒有任何資料列');
  return result.sort((a, b) => a.salary_limit - b.salary_limit);
}

/** 級距表 7 欄表頭（順序即匯出順序）與對應欄位 */
/** @type {ReadonlyArray<{ header: string, key: BracketKey }>} */
const BRACKET_EXPORT_COLUMNS = Object.freeze([
  { header: '月投保金額', key: 'salary_limit' },
  { header: '勞保費個人', key: 'labor_emp' },
  { header: '勞保費學校(不含職災)', key: 'labor_school' },
  { header: '勞保費學校-職災', key: 'labor_occupational' },
  { header: '勞退金-學校', key: 'pension_school' },
  { header: '健保費-個人', key: 'health_emp' },
  { header: '健保費-學校', key: 'health_school' },
]);

/**
 * 產生 7 欄級距表 xlsx（與匯入格式相同）。
 * @param {ReadonlyArray<ParsedBracket>} brackets 依 salary_limit 遞增
 * @returns {Promise<Uint8Array>}
 */
export async function buildBracketWorkbook(brackets) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('勞健保級距表');
  ws.columns = BRACKET_EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: 16, style: { numFmt: '#,##0' } }));
  for (const b of brackets) {
    ws.addRow({
      salary_limit: b.salary_limit,
      labor_emp: b.labor_emp,
      labor_school: b.labor_school,
      labor_occupational: b.labor_occupational,
      pension_school: b.pension_school,
      health_emp: b.health_emp,
      health_school: b.health_school,
    });
  }
  styleHeader(ws);
  return workbookToBytes(wb);
}

// ───────────────────────── 個人所得明細 ─────────────────────────

/** @typedef {'month_code' | 'employee_no' | 'name' | 'id_number' | 'birthday' | 'insurance_type' | 'source_name' | 'amount' | 'pension_rate'} DetailKey */

/** 9 欄表頭（順序即匯出順序）；第 9 欄「勞退自提」匯入時為選填（相容舊版 8 欄檔） */
export const DETAIL_HEADERS = Object.freeze(['月份資料', '職員編號', '姓名', '身分證號', '生日', '投保別', '薪資來源', '薪資', '勞退自提']);

/** 舊版 8 欄檔（無勞退自提欄）匯入時的提示 */
export const NO_PENSION_COLUMN_WARNING = '檔案沒有勞退自提欄，已全部以 0% 計';

/** @type {Readonly<Record<string, DetailKey>>} */
const DETAIL_HEADER_MAP = Object.freeze({
  [normalizeHeader('月份資料')]: 'month_code',
  [normalizeHeader('職員編號')]: 'employee_no',
  [normalizeHeader('姓名')]: 'name',
  [normalizeHeader('身分證號')]: 'id_number',
  [normalizeHeader('生日')]: 'birthday',
  [normalizeHeader('投保別')]: 'insurance_type',
  [normalizeHeader('薪資來源')]: 'source_name',
  [normalizeHeader('薪資')]: 'amount',
  [normalizeHeader('勞退自提')]: 'pension_rate',
});

/** 選填的明細欄位 */
/** @type {ReadonlyArray<DetailKey>} */
const DETAIL_OPTIONAL_KEYS = Object.freeze(['pension_rate']);

/**
 * 解析勞退自提率儲存格。
 *  - 空白 → null（未填）
 *  - number：若儲存格為百分比格式（Excel 輸入 6% 會存成 0.06），乘以 100
 *  - 字串：允許前後空白與 `%` 後綴（例 "6%"）
 *  - 結果必須為 PENSION_RATE_MIN~PENSION_RATE_MAX 的整數，否則回 NaN
 * @param {ExcelJS.Cell} cell
 * @returns {number | null}
 */
export function cellPensionRate(cell) {
  const value = cell.value;
  if (typeof value === 'number') {
    const isPercentFmt = typeof cell.numFmt === 'string' && cell.numFmt.includes('%');
    // 百分比格式的 0.06 → 6；四捨五入到小數 6 位以消除浮點誤差
    const n = isPercentFmt ? Math.round(value * 100 * 1e6) / 1e6 : value;
    return isValidPensionRate(n) ? n : Number.NaN;
  }
  const text = cellText(value).replace(/\s+/g, '').replace(/[%％]$/, '');
  if (text === '') return null;
  if (!/^\d+(\.0+)?$/.test(text)) return Number.NaN;
  const n = Number(text);
  return isValidPensionRate(n) ? n : Number.NaN;
}

/**
 * @param {number} n
 * @returns {boolean}
 */
function isValidPensionRate(n) {
  return Number.isInteger(n) && n >= PENSION_RATE_MIN && n <= PENSION_RATE_MAX;
}

const insuranceTypeSchema = z.union([z.literal('勞健'), z.literal('公健')]);

const detailRowSchema = z.object({
  month_code: z.string().max(20),
  employee_no: z.string().min(1, '職員編號為必填').max(20, '職員編號超過 20 字'),
  name: z.string().max(50, '姓名超過 50 字'),
  // 身分證號：trim + 大寫（空白另行檢查並彙整列號）
  id_number: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().max(20, '身分證號超過 20 字')),
  birthday: z.string().max(20, '生日超過 20 字'),
  insurance_type: insuranceTypeSchema,
  source_name: z.string().min(1, '薪資來源為必填').max(50, '薪資來源超過 50 字'),
  amount: z.number({ error: '薪資必須為整數' }).int('薪資必須為整數'),
});

/** @typedef {z.infer<typeof detailRowSchema>} DetailRow */

/**
 * @typedef {Object} ParsedPayroll
 * @property {string} employee_no
 * @property {string} name
 * @property {string} id_number
 * @property {string} birthday
 * @property {'勞健' | '公健'} insurance_type
 * @property {string} base_source_name  Step 0（基準）薪資來源名稱 = 該人員第一筆來源
 * @property {number} base_salary       Step 0（基準）薪資金額
 * @property {number} pension_rate  勞退自提率（%，0~6）
 * @property {number} source_order
 * @property {{ source_name: string, amount: number }[]} items
 */

/**
 * @typedef {Object} ParsedPayrollFile
 * @property {ParsedPayroll[]} persons
 * @property {string[]} warnings
 */

/**
 * 解析個人所得明細 xlsx（9 欄直式；相容舊版 8 欄），依身分證號（trim + 大寫）歸戶。
 * 身分證號空白 → 400；不同身分證號共用同一職員編號 → 400；
 * 同一身分證號各列職員編號／姓名／投保別不一致 → 以第一列為準並加 warning。
 * 勞退自提：空白 = 未填；同一人多列取有填寫者的最高值；全部未填為 0。
 * @param {Buffer} buffer
 * @param {number} year   使用者選擇的民國年
 * @param {number} month  使用者選擇的月份
 * @returns {Promise<ParsedPayrollFile>}
 */
export async function parsePayrollWorkbook(buffer, year, month) {
  const wb = await loadWorkbook(buffer);
  const { sheet, headerRow, columns } = locateHeader(wb, DETAIL_HEADER_MAP, DETAIL_OPTIONAL_KEYS);
  const pensionCol = columns.get('pension_rate');
  const expectedCode = `${year}${pad2(month)}`;

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, number>} 不一致的月份資料 → 列數 */
  const monthMismatch = new Map();
  /** @type {Map<string, { rows: DetailRow[], rowNos: number[], rates: (number | null)[], order: number }>} 身分證號 → 該人員各列 */
  const groups = new Map();
  /** @type {number[]} 身分證號空白的列號 */
  const blankIdRows = [];

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (isEmptyRow(row, columns.values())) continue;

    /**
     * @param {DetailKey} key
     * @returns {ExcelJS.CellValue}
     */
    const v = (key) => row.getCell(/** @type {number} */ (columns.get(key))).value;
    // 勞退自提（選填欄）：無此欄或空白 → null（未填）
    const pensionRate = pensionCol === undefined ? null : cellPensionRate(row.getCell(pensionCol));
    if (pensionRate !== null && Number.isNaN(pensionRate)) {
      const raw = cellText(row.getCell(/** @type {number} */ (pensionCol)).value);
      errors.push(`第 ${r} 列勞退自提必須為 ${PENSION_RATE_MIN}~${PENSION_RATE_MAX} 的整數（目前為「${raw}」）`);
      continue;
    }
    const amount = cellInt(v('amount'));
    const parsed = detailRowSchema.safeParse({
      month_code: cellText(v('month_code')),
      employee_no: cellText(v('employee_no')),
      name: cellText(v('name')),
      id_number: cellText(v('id_number')),
      birthday: cellText(v('birthday')),
      insurance_type: cellText(v('insurance_type')).replace(/\s+/g, ''),
      source_name: cellText(v('source_name')),
      amount: amount === null || Number.isNaN(amount) ? undefined : amount,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue.path[0]);
      const msg = field === 'insurance_type' ? '投保別必須為「勞健」或「公健」' : issue.message;
      errors.push(`第 ${r} 列${msg}`);
      continue;
    }
    const data = parsed.data;
    if (data.month_code !== expectedCode) {
      const k = data.month_code || '（空白）';
      monthMismatch.set(k, (monthMismatch.get(k) ?? 0) + 1);
    }
    // 依身分證號（schema 已 trim + 大寫）歸戶；空白先記下列號，最後一起回報
    if (data.id_number === '') {
      blankIdRows.push(r);
      continue;
    }
    const g = groups.get(data.id_number);
    if (g) {
      g.rows.push(data);
      g.rowNos.push(r);
      g.rates.push(pensionRate);
    } else {
      groups.set(data.id_number, { rows: [data], rowNos: [r], rates: [pensionRate], order: groups.size + 1 });
    }
  }

  if (blankIdRows.length > 0) errors.push(`身分證號為必填（第 ${formatRowNos(blankIdRows)} 列空白）`);
  throwIfErrors(errors);

  // 不同身分證號使用同一職員編號 → 資料錯誤（以每人第一列的職員編號為準，並檢查所有列）
  /** @type {Map<string, { ids: Set<string>, rowNos: number[] }>} 職員編號 → 使用者與列號 */
  const byEmployeeNo = new Map();
  for (const [idNumber, g] of groups) {
    g.rows.forEach((row, i) => {
      const e = byEmployeeNo.get(row.employee_no) ?? { ids: new Set(), rowNos: [] };
      e.ids.add(idNumber);
      e.rowNos.push(g.rowNos[i]);
      byEmployeeNo.set(row.employee_no, e);
    });
  }
  for (const [employeeNo, e] of byEmployeeNo) {
    if (e.ids.size > 1) {
      const rowNos = [...e.rowNos].sort((a, b) => a - b);
      errors.push(`職員編號 ${employeeNo} 被不同身分證號的人員使用（第 ${formatRowNos(rowNos)} 列）`);
    }
  }
  throwIfErrors(errors);
  if (groups.size === 0) throw new HttpError(400, '明細檔沒有任何資料列');
  if (pensionCol === undefined) warnings.push(NO_PENSION_COLUMN_WARNING);

  for (const [code, count] of monthMismatch) {
    warnings.push(`有 ${count} 列的月份資料為 ${code}，與匯入月份 ${year} 年 ${pad2(month)} 月不一致（已依選擇的月份匯入）`);
  }

  /** @type {ParsedPayroll[]} */
  const persons = [];
  for (const [idNumber, { rows, rowNos, rates, order }] of groups) {
    const first = rows[0];
    const employeeNo = first.employee_no;
    // 同一身分證號各列的職員編號／姓名／投保別不一致 → 以第一列為準（warning 不含身分證號）
    /** @type {string[]} */
    const diffFields = [];
    if (rows.some((x) => x.employee_no !== first.employee_no)) diffFields.push('職員編號');
    if (rows.some((x) => x.name !== first.name)) diffFields.push('姓名');
    if (rows.some((x) => x.insurance_type !== first.insurance_type)) diffFields.push('投保別');
    if (diffFields.length > 0) {
      warnings.push(
        `第 ${formatRowNos(rowNos)} 列為同一人員（同一身分證號），但${diffFields.join('／')}不一致，以第 ${rowNos[0]} 列（職員編號 ${employeeNo}）為準`,
      );
    }
    // 每人第一筆薪資來源為 Step 0（基準），其餘依 Excel 順序為 Step 1..N
    const items = rows.slice(1).map((x) => ({ source_name: x.source_name, amount: x.amount }));
    persons.push({
      employee_no: employeeNo,
      name: first.name,
      id_number: idNumber,
      birthday: first.birthday,
      insurance_type: first.insurance_type,
      base_source_name: first.source_name,
      base_salary: first.amount,
      pension_rate: mergePensionRates(rates),
      source_order: order,
      items,
    });
  }

  return { persons, warnings };
}

/**
 * @typedef {Object} ExportPerson
 * @property {number} roc_year
 * @property {number} month
 * @property {string} employee_no
 * @property {string} name
 * @property {string} id_number
 * @property {string} birthday
 * @property {string} insurance_type
 * @property {string} base_source_name
 * @property {number} base_salary
 * @property {number} pension_rate
 * @property {{ source_name: string, amount: number }[]} items
 */

/**
 * 產生 9 欄個人所得明細 xlsx（基準來源一列 + 每個 item 一列；勞退自提每列都寫該人員的自提率）。
 * @param {ReadonlyArray<ExportPerson>} persons
 * @returns {Promise<Uint8Array>}
 */
export async function buildPayrollWorkbook(persons) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('個人所得明細');
  ws.columns = [
    { header: DETAIL_HEADERS[0], key: 'month_code', width: 10 },
    { header: DETAIL_HEADERS[1], key: 'employee_no', width: 12 },
    { header: DETAIL_HEADERS[2], key: 'name', width: 12 },
    { header: DETAIL_HEADERS[3], key: 'id_number', width: 14 },
    { header: DETAIL_HEADERS[4], key: 'birthday', width: 10 },
    { header: DETAIL_HEADERS[5], key: 'insurance_type', width: 8 },
    { header: DETAIL_HEADERS[6], key: 'source_name', width: 18 },
    { header: DETAIL_HEADERS[7], key: 'amount', width: 12, style: { numFmt: '#,##0' } },
    { header: DETAIL_HEADERS[8], key: 'pension_rate', width: 10 },
  ];
  // 文字欄位設為文字格式，避免 Excel 吃掉前導 0
  for (const key of ['month_code', 'employee_no', 'id_number', 'birthday']) ws.getColumn(key).numFmt = '@';

  for (const p of persons) {
    const base = {
      month_code: `${p.roc_year}${pad2(p.month)}`,
      employee_no: p.employee_no,
      name: p.name,
      id_number: p.id_number,
      birthday: p.birthday,
      insurance_type: p.insurance_type,
      pension_rate: p.pension_rate,
    };
    ws.addRow({ ...base, source_name: baseSourceName(p.base_source_name), amount: p.base_salary });
    for (const item of p.items) ws.addRow({ ...base, source_name: item.source_name, amount: item.amount });
  }
  styleHeader(ws);
  return workbookToBytes(wb);
}
