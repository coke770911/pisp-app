// @ts-check
/**
 * 拆帳報表 xlsx（三個工作表）。
 * 計算一律呼叫 shared/splitCalc.js，不得在此複製拆帳邏輯。
 */
import ExcelJS from 'exceljs';
import {
  FEE_LABELS,
  INSURANCE_TYPE_LABELS,
  SPLIT_FEE_KEYS,
  baseSourceName,
  computeSplit,
  sortBrackets,
  zeroFees,
} from '../../../shared/splitCalc.js';
import { styleHeader, workbookToBytes } from './excel.js';

/** @typedef {import('../../../shared/splitCalc.js').Bracket} Bracket */
/** @typedef {import('../../../shared/splitCalc.js').Fees} Fees */
/** @typedef {import('./payrollService.js').PayrollDto} PayrollDto */

const MONEY_FMT = '#,##0';
/** 自提率顯示格式：數值 6 顯示為「6%」（儲存格仍為數字 6） */
const RATE_FMT = '0"%"';
/** 自提率欄位 key */
const RATE_KEY = 'pension_rate';

/**
 * 投保別顯示文字（公健 →「公健（只計健保）」）。
 * @param {string} t
 * @returns {string}
 */
function typeLabel(t) {
  return t === '勞健' || t === '公健' ? INSURANCE_TYPE_LABELS[t] : t;
}

/** 6 項保費 + 勞退自提 + 個人合計 + 學校合計 */
/** @type {ReadonlyArray<keyof Fees>} */
const FEE_COLUMNS = [...SPLIT_FEE_KEYS, 'emp_total', 'school_total'];

/**
 * @param {ExcelJS.Worksheet} ws
 * @param {ReadonlyArray<string>} moneyKeys 需套用千分位的欄位 key
 */
function applyMoneyFormat(ws, moneyKeys) {
  for (const key of moneyKeys) ws.getColumn(key).numFmt = MONEY_FMT;
}

/**
 * @param {Fees} acc
 * @param {Fees} add
 */
function addFees(acc, add) {
  for (const k of FEE_COLUMNS) acc[k] += add[k];
}

/**
 * Fees 轉成以欄位 key 為索引的列資料。
 * @param {Fees} f
 * @returns {Record<string, number>}
 */
function feeCells(f) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of FEE_COLUMNS) out[k] = f[k];
  return out;
}

/**
 * 保費欄位定義；withRate 時在「勞退自提」之後插入「自提率」欄。
 * @param {boolean} withRate
 * @returns {Partial<ExcelJS.Column>[]}
 */
function feeColumnDefs(withRate) {
  /** @type {Partial<ExcelJS.Column>[]} */
  const defs = [];
  for (const k of FEE_COLUMNS) {
    defs.push({ header: FEE_LABELS[k], key: k, width: 14 });
    if (withRate && k === 'pension_emp') defs.push({ header: '自提率', key: RATE_KEY, width: 8 });
  }
  return defs;
}

/**
 * @param {ExcelJS.Row} row
 */
function boldRow(row) {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  });
}

/**
 * @typedef {Object} SourceSummary
 * @property {string} source_name
 * @property {number} count
 * @property {number} amount
 * @property {Fees} fees
 */

/**
 * 產生拆帳報表。
 * @param {ReadonlyArray<PayrollDto>} payrolls 依 source_order 排序
 * @param {ReadonlyArray<Bracket>} brackets 該年度級距
 * @returns {Promise<Uint8Array>}
 */
export async function buildSplitReport(payrolls, brackets) {
  const sorted = sortBrackets(brackets);
  const wb = new ExcelJS.Workbook();

  // ── 工作表 1：逐筆拆帳明細 ──
  const ws1 = wb.addWorksheet('逐筆拆帳明細');
  ws1.columns = [
    { header: '職員編號', key: 'employee_no', width: 12 },
    { header: '姓名', key: 'name', width: 12 },
    { header: '投保別', key: 'insurance_type', width: 16 },
    { header: '步驟', key: 'step', width: 12 },
    { header: '薪資來源', key: 'source_name', width: 18 },
    { header: '本筆金額', key: 'amount', width: 12 },
    { header: '累計薪資', key: 'cumulative', width: 12 },
    { header: '投保級距', key: 'salary_limit', width: 12 },
    ...feeColumnDefs(true),
  ];
  applyMoneyFormat(ws1, ['amount', 'cumulative', 'salary_limit', ...FEE_COLUMNS]);
  ws1.getColumn(RATE_KEY).numFmt = RATE_FMT;

  // ── 工作表 2：薪資來源彙總（先建立工作表以確保順序，資料最後寫入） ──
  const ws2 = wb.addWorksheet('薪資來源彙總');
  /** @type {Map<string, SourceSummary>} 依實際薪資來源名稱分組（Map 保留首次出現順序） */
  const bySource = new Map();

  // ── 工作表 3：人員彙總 ──
  const ws3 = wb.addWorksheet('人員彙總');
  ws3.columns = [
    { header: '職員編號', key: 'employee_no', width: 12 },
    { header: '姓名', key: 'name', width: 12 },
    { header: '身分證號', key: 'id_number', width: 14 },
    { header: '投保別', key: 'insurance_type', width: 16 },
    { header: '基準來源', key: 'base_source_name', width: 18 },
    { header: '基準薪資', key: 'base_salary', width: 12 },
    { header: '總薪資', key: 'total_salary', width: 12 },
    { header: '最終級距', key: 'salary_limit', width: 12 },
    ...feeColumnDefs(true),
  ];
  applyMoneyFormat(ws3, ['base_salary', 'total_salary', 'salary_limit', ...FEE_COLUMNS]);
  ws3.getColumn(RATE_KEY).numFmt = RATE_FMT;
  const grandPerson = zeroFees();
  let grandBase = 0;
  let grandSalary = 0;

  for (const p of payrolls) {
    const baseName = baseSourceName(p.base_source_name);
    const result = computeSplit(
      {
        insurance_type: p.insurance_type,
        base_source_name: baseName,
        base_salary: p.base_salary,
        pension_rate: p.pension_rate,
        items: p.items,
      },
      sorted,
    );
    const last = result.steps[result.steps.length - 1];
    const totalSalary = last ? last.cumulative : p.base_salary;

    // 勞健、公健皆逐筆疊加拆帳；公健的勞保三項、勞退與勞退自提已由 computeSplit 設為 0
    {
      for (const s of result.steps) {
        ws1.addRow({
          employee_no: p.employee_no,
          name: p.name,
          insurance_type: typeLabel(p.insurance_type),
          step: s.step === 0 ? 'Step 0 基準' : `Step ${s.step}`,
          source_name: s.source_name,
          amount: s.amount,
          cumulative: s.cumulative,
          salary_limit: s.salary_limit,
          ...feeCells(s.diff),
          [RATE_KEY]: p.pension_rate,
        });
        // 薪資來源彙總：依實際名稱分組；Step 0 歸入其基準來源名稱，與同名加項合併
        const name = s.step === 0 ? baseName : s.source_name;
        let sum = bySource.get(name);
        if (!sum) {
          sum = { source_name: name, count: 0, amount: 0, fees: zeroFees() };
          bySource.set(name, sum);
        }
        sum.count += 1;
        sum.amount += s.amount;
        addFees(sum.fees, s.diff);
      }
      const subtotal = ws1.addRow({
        employee_no: p.employee_no,
        name: p.name,
        step: '小計',
        amount: totalSalary,
        cumulative: totalSalary,
        salary_limit: last ? last.salary_limit : 0,
        ...feeCells(result.total),
        [RATE_KEY]: p.pension_rate,
      });
      boldRow(subtotal);
    }

    ws3.addRow({
      employee_no: p.employee_no,
      name: p.name,
      id_number: p.id_number,
      insurance_type: typeLabel(p.insurance_type),
      base_source_name: baseName,
      base_salary: p.base_salary,
      total_salary: totalSalary,
      salary_limit: last ? last.salary_limit : 0,
      ...feeCells(result.total),
      [RATE_KEY]: p.pension_rate,
    });
    addFees(grandPerson, result.total);
    grandBase += p.base_salary;
    grandSalary += totalSalary;
  }
  boldRow(ws3.addRow({ employee_no: '總計', base_salary: grandBase, total_salary: grandSalary, ...feeCells(grandPerson) }));

  // 工作表 2 實際輸出
  ws2.columns = [
    { header: '薪資來源', key: 'source_name', width: 18 },
    { header: '人次', key: 'count', width: 8 },
    { header: '薪資合計', key: 'amount', width: 14 },
    ...feeColumnDefs(false),
  ];
  applyMoneyFormat(ws2, ['count', 'amount', ...FEE_COLUMNS]);
  const grandSource = zeroFees();
  let grandCount = 0;
  let grandAmount = 0;
  for (const s of bySource.values()) {
    if (s.count === 0) continue;
    ws2.addRow({ source_name: s.source_name, count: s.count, amount: s.amount, ...feeCells(s.fees) });
    addFees(grandSource, s.fees);
    grandCount += s.count;
    grandAmount += s.amount;
  }
  boldRow(ws2.addRow({ source_name: '總計', count: grandCount, amount: grandAmount, ...feeCells(grandSource) }));

  for (const ws of [ws1, ws2, ws3]) styleHeader(ws);

  return workbookToBytes(wb);
}
