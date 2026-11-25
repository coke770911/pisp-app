// @ts-check
/**
 * 本月與上月人員資料比對（前端計算）。
 * 人員識別鍵 = 身分證號 id_number（trim + 大寫）；職員編號可能被修改，不作為配對依據。
 */

/** @typedef {import('../api/schemas.js').Payroll} Payroll */

/**
 * @typedef {Object} ChangeFlags
 * @property {boolean} isNew        新進（上月無此身分證號）
 * @property {boolean} employeeNoChanged 職員編號變動（同一身分證號，上月與本月職員編號不同）
 * @property {string | null} previousEmployeeNo 上月職員編號（無上月資料時為 null）
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
  employeeNoChanged: false,
  previousEmployeeNo: null,
  baseChanged: false,
  itemsChanged: false,
  typeChanged: false,
  pensionChanged: false,
  any: false,
});

/**
 * 正規化身分證號（trim + 大寫；null/undefined 視為空字串）。
 * @param {string | null | undefined} idNumber
 * @returns {string}
 */
export function normalizeIdNumber(idNumber) {
  return (idNumber ?? '').trim().toUpperCase();
}

/**
 * 人員配對鍵：以正規化身分證號為準。
 * 舊資料若身分證號空白（理論上後端已要求必填），退回以職員編號配對，避免全部被誤判為新進／離職。
 * @param {Payroll} p
 * @returns {string}
 */
export function personKey(p) {
  const id = normalizeIdNumber(p.id_number);
  return id !== '' ? `id:${id}` : `no:${p.employee_no.trim()}`;
}

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
 * @param {Payroll | undefined} previous 上月同一身分證號的資料
 * @returns {ChangeFlags}
 */
export function compareWithPrevious(current, previous) {
  if (!previous) return { ...NO_CHANGE, isNew: true, any: true };
  const employeeNoChanged = current.employee_no.trim() !== previous.employee_no.trim();
  const baseChanged = current.base_salary !== previous.base_salary;
  const itemsChanged = itemsSignature(current) !== itemsSignature(previous);
  const typeChanged = current.insurance_type !== previous.insurance_type;
  const pensionChanged = current.pension_rate !== previous.pension_rate;
  return {
    isNew: false,
    employeeNoChanged,
    previousEmployeeNo: previous.employee_no,
    baseChanged,
    itemsChanged,
    typeChanged,
    pensionChanged,
    any: employeeNoChanged || baseChanged || itemsChanged || typeChanged || pensionChanged,
  };
}

/**
 * 以人員配對鍵（身分證號）建立索引；以 {@link personKey} 取值。
 * @param {ReadonlyArray<Payroll>} list
 * @returns {Map<string, Payroll>}
 */
export function indexByPersonKey(list) {
  /** @type {Map<string, Payroll>} */
  const map = new Map();
  for (const p of list) {
    const key = personKey(p);
    if (!map.has(key)) map.set(key, p);
  }
  return map;
}

/**
 * 上月有、本月無的人員（以身分證號判斷）。
 * @param {ReadonlyArray<Payroll>} previous
 * @param {ReadonlyArray<Payroll>} current
 * @returns {Payroll[]}
 */
export function missingInCurrent(previous, current) {
  /** @type {Set<string>} */
  const cur = new Set(current.map(personKey));
  return previous.filter((p) => !cur.has(personKey(p)));
}
