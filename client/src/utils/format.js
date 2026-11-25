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
 * 將日期時間字串格式化為民國年（例：`115/11/25 14:03`）；空值或無效回 `—`。
 * @param {string | null | undefined} value ISO 日期時間字串
 * @returns {string}
 */
export function formatRocDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const rocYear = d.getFullYear() - 1911;
  return `${rocYear}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
