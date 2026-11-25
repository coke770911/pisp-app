// @ts-check
/** 本月與上月人員資料比對（前端計算） */

/** @typedef {import('../api/schemas.js').Payroll} Payroll */

/**
 * @typedef {Object} ChangeFlags
 * @property {boolean} isNew        新進（上月無此職員編號）
 * @property {boolean} baseChanged  本薪變動
 * @property {boolean} itemsChanged 加項變動（名稱、金額或數量不同）
 * @property {boolean} typeChanged  投保別變動
 * @property {boolean} pensionChanged 勞退自提率變動
 * @property {boolean} any          任一變動
 */

/** 無變動旗標 */
/** @type {Readonly<ChangeFlags>} */
export const NO_CHANGE = Object.freeze({
  isNew: false,
  baseChanged: false,
  itemsChanged: false,
  typeChanged: false,
  pensionChanged: false,
  any: false,
});

/**
 * 依 sort_order 排序後的加項簽章。
 * @param {Payroll} p
 * @returns {string}
 */
function itemsSignature(p) {
  return JSON.stringify(
    [...p.items]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((it) => [it.source_name.trim(), it.amount]),
  );
}

/**
 * @param {Payroll} current
 * @param {Payroll | undefined} previous
 * @returns {ChangeFlags}
 */
export function compareWithPrevious(current, previous) {
  if (!previous) return { ...NO_CHANGE, isNew: true, any: true };
  const baseChanged = current.base_salary !== previous.base_salary;
  const itemsChanged = itemsSignature(current) !== itemsSignature(previous);
  const typeChanged = current.insurance_type !== previous.insurance_type;
  const pensionChanged = current.pension_rate !== previous.pension_rate;
  return {
    isNew: false,
    baseChanged,
    itemsChanged,
    typeChanged,
    pensionChanged,
    any: baseChanged || itemsChanged || typeChanged || pensionChanged,
  };
}

/**
 * 以職員編號建立索引。
 * @param {ReadonlyArray<Payroll>} list
 * @returns {Map<string, Payroll>}
 */
export function indexByEmployeeNo(list) {
  /** @type {Map<string, Payroll>} */
  const map = new Map();
  for (const p of list) map.set(p.employee_no, p);
  return map;
}

/**
 * 上月有、本月無的人員。
 * @param {ReadonlyArray<Payroll>} previous
 * @param {ReadonlyArray<Payroll>} current
 * @returns {Payroll[]}
 */
export function missingInCurrent(previous, current) {
  const cur = new Set(current.map((p) => p.employee_no));
  return previous.filter((p) => !cur.has(p.employee_no));
}
