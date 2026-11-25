// @ts-check
/**
 * 檔案上傳（multer memoryStorage，只收 .xlsx，上限 10MB）。
 */
import path from 'node:path';
import multer from 'multer';
import { HttpError } from '../utils/http.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const multerSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.xlsx') {
      cb(new HttpError(400, '只接受 .xlsx 格式的檔案'));
      return;
    }
    cb(null, true);
  },
}).single('file');

/**
 * 包裝 multer：將 MulterError 轉成可公開的中文訊息，並確認確實有上傳檔案。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
export function uploadXlsx(req, res, next) {
  multerSingle(req, res, (/** @type {unknown} */ err) => {
    if (err instanceof HttpError) {
      next(err);
      return;
    }
    if (err instanceof multer.MulterError) {
      next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? '檔案超過 10MB 上限' : '檔案上傳格式錯誤'));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    if (!req.file) {
      next(new HttpError(400, '請選擇要上傳的 .xlsx 檔案'));
      return;
    }
    next();
  });
}
