// @ts-check
/**
 * HTTP 共用工具：錯誤類別、zod 驗證、檔案下載。
 */
import { z } from 'zod';

/** 可直接回給前端的錯誤（message 必須是可公開的中文訊息） */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    /** @type {number} */
    this.status = status;
  }
}

/**
 * 以 zod 驗證外部輸入，失敗時丟出 400 HttpError。
 * @template {z.ZodType} S
 * @param {S} schema
 * @param {unknown} input
 * @param {string} [message]
 * @returns {z.infer<S>}
 */
export function parseInput(schema, input, message = '輸入資料格式錯誤') {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, message);
  return r.data;
}

/** 民國年（查詢字串或 multipart 欄位，字串轉整數） */
export const yearSchema = z.coerce.number().int().min(1).max(999);
/** 月份 1~12 */
export const monthSchema = z.coerce.number().int().min(1).max(12);

export const yearQuerySchema = z.object({ year: yearSchema });
export const yearMonthSchema = z.object({ year: yearSchema, month: monthSchema });

/**
 * @param {number} n
 * @returns {string} 兩位數字
 */
export function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 送出 xlsx 檔案下載。
 * @param {import('express').Response} res
 * @param {string} filename
 * @param {Uint8Array} data
 */
export function sendXlsx(res, filename, data) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(data));
}
