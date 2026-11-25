// @ts-check
/** 格式化與日期工具 */

const numberFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });

/**
 * 整數千分位。
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  return numberFormatter.format(n);
}

/**
 * 差額格式：正數加 +，0 顯示 0。
 * @param {number} n
 * @returns {string}
 */
export function formatDiff(n) {
  if (n > 0) return `+${numberFormatter.format(n)}`;
  return numberFormatter.format(n);
}

/**
 * @param {number} n
 * @returns {string}
 */
export function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 取得上個月（1 月 → 去年 12 月）。
 * @param {number} year 民國年
 * @param {number} month 1~12
 * @returns {{ year: number, month: number }}
 */
export function previousMonth(year, month) {
  return month <= 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/**
 * 將輸入轉為整數；無效時回 null。
 * @param {string | number} value
 * @returns {number | null}
 */
export function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const s = value.replace(/,/g, '').trim();
  if (s === '' || !/^-?\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}
