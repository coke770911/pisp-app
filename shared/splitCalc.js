// @ts-check
/**
 * HISP 逐筆疊加拆帳核心演算法（前後端共用，純函式、無 I/O）。
 *
 * 規則：
 *  - Step 0：以「本薪」對照級距，算出基準級距與基準保費（全數歸屬本薪）。
 *  - Step N：累計薪資 += 第 N+1 個薪資來源金額，重新對照級距，
 *            差額 = Step N 保費 − Step N-1 保費，歸屬該薪資來源（未跨級距則為 0）。
 *  - 投保別為「公健」者只計算健保：同樣逐筆疊加、對照級距，
 *    但勞保三項（個人、學校、職災）與勞退金-學校一律為 0，只計健保個人、健保學校（healthOnly = true）。
 *  - 級距對照：取 salary_limit >= 累計薪資 的最小級距；超過最高級距則取最高級距。
 *  - 勞退自提：pension_emp = 四捨五入(對照級距 salary_limit × 自提率%)，自提率為 0~6（常用 0、1、3、6）。
 *    與其他保費一樣逐步重算、差額歸屬該薪資來源；計入個人負擔合計。公健無勞退，自提一律為 0。
 */

/** 勞退自提率允許值（%） */
export const PENSION_RATE_MIN = 0;
export const PENSION_RATE_MAX = 6;

/** @typedef {'勞健' | '公健'} InsuranceType */

/**
 * @typedef {Object} Bracket
 * @property {number} salary_limit        月投保金額
 * @property {number} labor_emp           勞保費個人
 * @property {number} labor_school        勞保費學校(不含職災)
 * @property {number} labor_occupational  勞保費學校-職災
 * @property {number} pension_school      勞退金-學校
 * @property {number} health_emp          健保費-個人
 * @property {number} health_school       健保費-學校
 */

/**
 * @typedef {Object} Fees
 * @property {number} labor_emp
 * @property {number} labor_school
 * @property {number} labor_occupational
 * @property {number} pension_school
 * @property {number} health_emp
 * @property {number} health_school
 * @property {number} pension_emp   勞退自提（個人）= 級距 × 自提率%
 * @property {number} emp_total     個人負擔合計（勞保個人 + 健保個人 + 勞退自提）
 * @property {number} school_total  學校負擔合計（勞保學校 + 職災 + 勞退 + 健保學校）
 */

/**
 * @typedef {Object} SplitInputItem
 * @property {string} source_name
 * @property {number} amount
 */

/**
 * @typedef {Object} SplitStep
 * @property {number} step            0 = 本薪基準，1..N = 第 N 次拆帳
 * @property {string} source_name
 * @property {number} amount          本筆金額
 * @property {number} cumulative      累計薪資
 * @property {number} salary_limit    對照後投保級距（無級距資料時為 0）
 * @property {Fees} fees              本階段保費（公健只有健保兩項）
 * @property {Fees} diff              歸屬本筆的拆帳金額（Step 0 = 基準保費本身）
 */

/**
 * @typedef {Object} SplitResult
 * @property {boolean} healthOnly     是否為公健（只計健保，勞保與勞退為 0）
 * @property {boolean} bracketMissing 該年度無級距資料，無法計算
 * @property {SplitStep[]} steps
 * @property {Fees} total             最終階段保費（= 所有 diff 加總）
 */

/** @type {ReadonlyArray<keyof Bracket & keyof Fees>} */
export const FEE_KEYS = Object.freeze([
  'labor_emp',
  'labor_school',
  'labor_occupational',
  'pension_school',
  'health_emp',
  'health_school',
]);

/** 拆帳表顯示用的保費欄位：級距表 6 項 + 勞退自提（不含合計） */
/** @type {ReadonlyArray<Exclude<keyof Fees, 'emp_total' | 'school_total'>>} */
export const SPLIT_FEE_KEYS = Object.freeze([...FEE_KEYS, 'pension_emp']);

/** 保費欄位中文名稱（報表與前端共用） */
/** @type {Readonly<Record<keyof Fees, string>>} */
export const FEE_LABELS = Object.freeze({
  labor_emp: '勞保費個人',
  labor_school: '勞保費學校(不含職災)',
  labor_occupational: '勞保費學校-職災',
  pension_school: '勞退金-學校',
  health_emp: '健保費-個人',
  health_school: '健保費-學校',
  pension_emp: '勞退自提',
  emp_total: '個人負擔合計',
  school_total: '學校負擔合計',
});

/** 公健人員不計的保費欄位（勞保三項 + 勞退） */
/** @type {ReadonlyArray<keyof Bracket & keyof Fees>} */
export const HEALTH_ONLY_ZERO_KEYS = Object.freeze([
  'labor_emp',
  'labor_school',
  'labor_occupational',
  'pension_school',
]);

/** 投保別顯示名稱 */
/** @type {Readonly<Record<InsuranceType, string>>} */
export const INSURANCE_TYPE_LABELS = Object.freeze({
  勞健: '勞健',
  公健: '公健（只計健保）',
});

/** @returns {Fees} */
export function zeroFees() {
  return {
    labor_emp: 0,
    labor_school: 0,
    labor_occupational: 0,
    pension_school: 0,
    health_emp: 0,
    health_school: 0,
    pension_emp: 0,
    emp_total: 0,
    school_total: 0,
  };
}

/**
 * @param {Bracket} b
 * @param {boolean} healthOnly 公健：勞保三項與勞退（含自提）為 0
 * @param {number} pensionRate 勞退自提率（%）
 * @returns {Fees}
 */
function feesFromBracket(b, healthOnly, pensionRate) {
  /** @type {Fees} */
  const f = zeroFees();
  for (const k of FEE_KEYS) f[k] = Number(b[k]) || 0;
  f.pension_emp = Math.round((b.salary_limit * pensionRate) / 100);
  if (healthOnly) {
    for (const k of HEALTH_ONLY_ZERO_KEYS) f[k] = 0;
    f.pension_emp = 0;
  }
  f.emp_total = f.labor_emp + f.health_emp + f.pension_emp;
  f.school_total = f.labor_school + f.labor_occupational + f.pension_school + f.health_school;
  return f;
}

/**
 * @param {Fees} a
 * @param {Fees} b
 * @returns {Fees} a − b
 */
function subFees(a, b) {
  /** @type {Fees} */
  const r = zeroFees();
  for (const k of /** @type {(keyof Fees)[]} */ (Object.keys(r))) r[k] = a[k] - b[k];
  return r;
}

/**
 * 依累計薪資找出適用級距。
 * @param {ReadonlyArray<Bracket>} sortedBrackets 已依 salary_limit 遞增排序
 * @param {number} salary
 * @returns {Bracket | null}
 */
export function findBracket(sortedBrackets, salary) {
  if (sortedBrackets.length === 0) return null;
  for (const b of sortedBrackets) {
    if (b.salary_limit >= salary) return b;
  }
  return sortedBrackets[sortedBrackets.length - 1];
}

/**
 * @param {ReadonlyArray<Bracket>} brackets
 * @returns {Bracket[]}
 */
export function sortBrackets(brackets) {
  return [...brackets].sort((a, b) => a.salary_limit - b.salary_limit);
}

/**
 * 勞退自提率正規化：非 0~6 的整數一律視為 0。
 * @param {number | null | undefined} rate
 * @returns {number}
 */
export function normalizePensionRate(rate) {
  const n = Number(rate);
  return Number.isInteger(n) && n >= PENSION_RATE_MIN && n <= PENSION_RATE_MAX ? n : 0;
}

/**
 * 同一人多列的勞退自提率合併規則：空白視為未填；有填寫者取最高值；全部未填則為 0。
 * @param {ReadonlyArray<number | null>} rates 每列的自提率（未填為 null）
 * @returns {number}
 */
export function mergePensionRates(rates) {
  /** @type {number[]} */
  const filled = rates.filter(/** @returns {r is number} */ (r) => r !== null);
  return filled.length === 0 ? 0 : Math.max(...filled);
}

/**
 * 執行單一人員的逐筆疊加拆帳。
 * @param {{ insurance_type: string, base_salary: number, pension_rate?: number, items: ReadonlyArray<SplitInputItem> }} person
 *        pension_rate：勞退自提率（%，0~6，未提供視為 0）
 * @param {ReadonlyArray<Bracket>} sortedBrackets 已依 salary_limit 遞增排序
 * @returns {SplitResult}
 */
export function computeSplit(person, sortedBrackets) {
  const healthOnly = person.insurance_type === '公健';
  const pensionRate = normalizePensionRate(person.pension_rate);
  const bracketMissing = sortedBrackets.length === 0;
  /** @type {SplitInputItem[]} */
  const sources = [{ source_name: '本薪', amount: Number(person.base_salary) || 0 }, ...person.items];

  /** @type {SplitStep[]} */
  const steps = [];
  let cumulative = 0;
  /** @type {Fees} */
  let prevFees = zeroFees();

  sources.forEach((src, idx) => {
    const amount = Number(src.amount) || 0;
    cumulative += amount;
    if (bracketMissing) {
      steps.push({ step: idx, source_name: src.source_name, amount, cumulative, salary_limit: 0, fees: zeroFees(), diff: zeroFees() });
      return;
    }
    const b = /** @type {Bracket} */ (findBracket(sortedBrackets, cumulative));
    const fees = feesFromBracket(b, healthOnly, pensionRate);
    const diff = idx === 0 ? fees : subFees(fees, prevFees);
    steps.push({ step: idx, source_name: src.source_name, amount, cumulative, salary_limit: b.salary_limit, fees, diff });
    prevFees = fees;
  });

  return { healthOnly, bracketMissing, steps, total: bracketMissing ? zeroFees() : prevFees };
}

/**
 * 取得目前民國年。
 * @param {Date} [d]
 * @returns {number}
 */
export function currentRocYear(d = new Date()) {
  return d.getFullYear() - 1911;
}
