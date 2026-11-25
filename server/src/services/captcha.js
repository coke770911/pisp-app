// @ts-check
/**
 * 4 位數字圖形驗證碼。
 * - 答案以 crypto 隨機產生，只存在伺服器記憶體 Map（一次性、有效期限、定期清理、筆數上限）。
 * - 圖片為 SVG：每個數字以自訂筆畫（線段／貝茲曲線）繪成 <path>，座標在伺服器端套用
 *   隨機位移、旋轉、縮放與抖動後輸出；另加干擾曲線與雜點。
 * - SVG 內不使用 <text>，也不在任何屬性、id、註解中放入答案。
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** Map 筆數上限（超過先刪最舊） */
const MAX_ENTRIES = 5000;

/** 驗證碼有效毫秒數 */
const TTL_MS = Math.max(1, env.CAPTCHA_TTL_SECONDS) * 1000;

/**
 * @typedef {Object} CaptchaEntry
 * @property {string} answer     4 位數字答案
 * @property {number} expiresAt  到期時間（epoch ms）
 */

/**
 * 驗證碼儲存區（captchaId → 答案）。Map 依插入順序迭代，第一筆即最舊。
 * 僅供本模組與單元測試讀取；正式 API 絕不回傳答案。
 * @type {Map<string, CaptchaEntry>}
 */
export const captchaStore = new Map();

// 定期清除過期驗證碼
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of captchaStore) if (entry.expiresAt <= now) captchaStore.delete(id);
}, 60_000);
cleanupTimer.unref();

// ───────────────────────── 隨機工具 ─────────────────────────

/**
 * crypto 隨機浮點數 [min, max)。
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function rand(min, max) {
  return min + (crypto.randomInt(0, 1_000_000) / 1_000_000) * (max - min);
}

/**
 * crypto 隨機整數 [min, max]。
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

/**
 * 原地洗牌（Fisher–Yates）。
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// ───────────────────────── 數字筆畫定義 ─────────────────────────

/**
 * 筆畫指令（座標系：寬 20、高 30，原點在左上）。
 * @typedef {['M', number, number] | ['L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number]} StrokeCmd
 */

/** @type {ReadonlyArray<ReadonlyArray<StrokeCmd>>} 索引即數字 0–9 */
const DIGIT_STROKES = [
  // 0：橢圓
  [
    ['M', 10, 0],
    ['C', 22, 0, 22, 30, 10, 30],
    ['C', -2, 30, -2, 0, 10, 0],
  ],
  // 1：斜鉤 + 直線 + 底座
  [
    ['M', 4, 7],
    ['L', 11, 0],
    ['L', 11, 30],
    ['M', 5, 30],
    ['L', 17, 30],
  ],
  // 2
  [
    ['M', 2, 8],
    ['C', 2, -1, 18, -1, 18, 8],
    ['C', 18, 15, 6, 20, 1, 30],
    ['L', 19, 30],
  ],
  // 3
  [
    ['M', 2, 4],
    ['C', 8, -2, 19, 1, 17, 8],
    ['C', 16, 13, 12, 14, 8, 14],
    ['C', 14, 14, 20, 17, 19, 23],
    ['C', 18, 31, 6, 32, 1, 26],
  ],
  // 4
  [
    ['M', 14, 30],
    ['L', 14, 0],
    ['L', 1, 20],
    ['L', 20, 20],
  ],
  // 5
  [
    ['M', 18, 0],
    ['L', 4, 0],
    ['L', 2, 13],
    ['C', 8, 9, 19, 11, 19, 20],
    ['C', 19, 31, 6, 32, 1, 26],
  ],
  // 6
  [
    ['M', 16, 2],
    ['C', 8, -2, 1, 6, 1, 18],
    ['C', 1, 28, 6, 30, 10, 30],
    ['C', 16, 30, 19, 26, 19, 21],
    ['C', 19, 15, 15, 12, 10, 12],
    ['C', 5, 12, 2, 15, 1, 19],
  ],
  // 7
  [
    ['M', 1, 3],
    ['L', 1, 0],
    ['L', 19, 0],
    ['Q', 12, 12, 8, 30],
  ],
  // 8
  [
    ['M', 10, 14],
    ['C', 3, 14, 2, 8, 3, 5],
    ['C', 5, -1, 15, -1, 17, 5],
    ['C', 18, 8, 17, 14, 10, 14],
    ['C', 2, 14, 1, 20, 1, 22],
    ['C', 1, 31, 19, 31, 19, 22],
    ['C', 19, 18, 16, 14, 10, 14],
  ],
  // 9
  [
    ['M', 19, 11],
    ['C', 19, 16, 15, 18, 10, 18],
    ['C', 5, 18, 1, 15, 1, 10],
    ['C', 1, 4, 5, 0, 10, 0],
    ['C', 16, 0, 19, 4, 19, 12],
    ['C', 19, 24, 12, 32, 4, 28],
  ],
];

// ───────────────────────── SVG 產生 ─────────────────────────

const WIDTH = 160;
const HEIGHT = 60;

/**
 * 數值格式化（1 位小數，避免輸出過長；不會產生 4 位以上連續數字）。
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/**
 * 隨機顏色（rgb() 格式；不使用 16 進位以免出現連續數字字串）。
 * @param {number} min
 * @param {number} max
 * @returns {string}
 */
function randColor(min, max) {
  return `rgb(${randInt(min, max)},${randInt(min, max)},${randInt(min, max)})`;
}

/**
 * 將一個數字的筆畫套用仿射變換後輸出 path d。
 * @param {number} digit
 * @param {number} cx  字元中心 x
 * @param {number} cy  字元中心 y
 * @returns {string}
 */
function digitPath(digit, cx, cy) {
  const strokes = DIGIT_STROKES[digit];
  const scale = rand(1.1, 1.45);
  const scaleX = scale * rand(0.85, 1.15);
  const angle = (rand(-25, 25) * Math.PI) / 180;
  const skew = rand(-0.25, 0.25);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  /**
   * 字元座標 → 畫布座標（以字元中心 (10,15) 為原點縮放、傾斜、旋轉，再加小抖動）。
   * @param {number} x
   * @param {number} y
   * @returns {string}
   */
  const pt = (x, y) => {
    const lx = (x - 10 + (y - 15) * skew) * scaleX + rand(-0.8, 0.8);
    const ly = (y - 15) * scale + rand(-0.8, 0.8);
    return `${fmt(cx + lx * cos - ly * sin)} ${fmt(cy + lx * sin + ly * cos)}`;
  };

  /** @type {string[]} */
  const parts = [];
  for (const cmd of strokes) {
    switch (cmd[0]) {
      case 'M':
      case 'L':
        parts.push(`${cmd[0]}${pt(cmd[1], cmd[2])}`);
        break;
      case 'Q':
        parts.push(`Q${pt(cmd[1], cmd[2])} ${pt(cmd[3], cmd[4])}`);
        break;
      case 'C':
        parts.push(`C${pt(cmd[1], cmd[2])} ${pt(cmd[3], cmd[4])} ${pt(cmd[5], cmd[6])}`);
        break;
    }
  }
  return parts.join(' ');
}

/**
 * 產生干擾曲線 path d（橫跨畫布的三次貝茲曲線）。
 * @returns {string}
 */
function noiseCurve() {
  const p = () => `${fmt(rand(0, WIDTH))} ${fmt(rand(0, HEIGHT))}`;
  return `M${fmt(rand(-5, 20))} ${fmt(rand(5, HEIGHT - 5))} C${p()} ${p()} ${fmt(rand(WIDTH - 20, WIDTH + 5))} ${fmt(rand(5, HEIGHT - 5))}`;
}

/**
 * 依答案產生 SVG 原始字串。
 * @param {string} answer
 * @returns {string}
 */
export function renderCaptchaSvg(answer) {
  /** @type {string[]} */
  const elements = [];

  // 數字：每字獨立位移、旋轉、縮放
  const cell = (WIDTH - 20) / answer.length;
  for (let i = 0; i < answer.length; i += 1) {
    const digit = Number(answer[i]);
    const cx = 10 + cell * (i + 0.5) + rand(-5, 5);
    const cy = HEIGHT / 2 + rand(-5, 5);
    elements.push(
      `<path d="${digitPath(digit, cx, cy)}" fill="none" stroke="${randColor(20, 110)}" stroke-width="${fmt(rand(2.4, 3.4))}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  // 干擾曲線 3–5 條
  const curves = randInt(3, 5);
  for (let i = 0; i < curves; i += 1) {
    elements.push(
      `<path d="${noiseCurve()}" fill="none" stroke="${randColor(40, 160)}" stroke-width="${fmt(rand(1, 2.2))}" stroke-linecap="round"/>`,
    );
  }

  // 雜點
  const dots = randInt(30, 50);
  for (let i = 0; i < dots; i += 1) {
    elements.push(
      `<circle cx="${fmt(rand(0, WIDTH))}" cy="${fmt(rand(0, HEIGHT))}" r="${fmt(rand(0.6, 1.8))}" fill="${randColor(60, 200)}"/>`,
    );
  }

  // 打亂繪製順序，DOM 順序不對應數字位置
  shuffle(elements);
  return (
    `<svg xmlns="${SVG_NS}" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${randColor(225, 250)}"/>` +
    elements.join('') +
    '</svg>'
  );
}

/** SVG 命名空間網址（固定字串） */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 去除固定命名空間網址後的 SVG 內容（供答案外洩檢查）。
 * @param {string} svg
 * @returns {string}
 */
export function svgBody(svg) {
  return svg.replace(`xmlns="${SVG_NS}"`, '');
}

// ───────────────────────── 對外 API ─────────────────────────

/**
 * @typedef {Object} IssuedCaptcha
 * @property {string} captchaId  16 bytes 隨機 hex
 * @property {string} image      data:image/svg+xml;base64,...
 */

/**
 * 產生新驗證碼並存入 Map；回傳值不含答案。
 * @returns {IssuedCaptcha}
 */
export function issueCaptcha() {
  const answer = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
  // 防禦性檢查：圖形內容不得含答案字串（數值皆為 1 位小數、顏色用 rgb()，格式上不會發生，仍保險重繪；
  // 只檢查 xmlns 之後的動態內容——固定的命名空間網址含 "2000"，與答案無關，若一併檢查會在答案為 2000 時無限重繪）
  let svg = renderCaptchaSvg(answer);
  for (let i = 0; i < 5 && svgBody(svg).includes(answer); i += 1) svg = renderCaptchaSvg(answer);

  // 超過上限先刪最舊
  while (captchaStore.size >= MAX_ENTRIES) {
    const oldest = captchaStore.keys().next();
    if (oldest.done) break;
    captchaStore.delete(oldest.value);
  }
  const captchaId = crypto.randomBytes(16).toString('hex');
  captchaStore.set(captchaId, { answer, expiresAt: Date.now() + TTL_MS });
  return { captchaId, image: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}` };
}

/**
 * 驗證並作廢驗證碼（一次性：無論對錯都立即刪除）。
 * @param {unknown} captchaId
 * @param {unknown} code
 * @returns {boolean}
 */
export function consumeCaptcha(captchaId, code) {
  if (typeof captchaId !== 'string' || captchaId === '') return false;
  const entry = captchaStore.get(captchaId);
  captchaStore.delete(captchaId);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return false;
  return crypto.timingSafeEqual(Buffer.from(code, 'utf8'), Buffer.from(entry.answer, 'utf8'));
}
