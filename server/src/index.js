// @ts-check
/**
 * HISP 後端入口：Express + Sequelize。
 * 單一 Port 同時提供 /api/* 與前端靜態檔（SPA History Fallback）。
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import { env, SERVER_DIR } from './config/env.js';
import { initDatabase } from './models/index.js';
import { requireAdmin, requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { bracketsRouter } from './routes/brackets.js';
import { payrollsRouter } from './routes/payrolls.js';
import { reportsRouter } from './routes/reports.js';
import { usersRouter } from './routes/users.js';
import { HttpError } from './utils/http.js';

const APP_NAME = 'HISP - 人事勞健保加退拆帳系統';

/** 讀取 server/package.json 版本 */
const pkgSchema = z.object({ version: z.string() });
const APP_VERSION = pkgSchema.parse(JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'))).version;

const PUBLIC_DIR = path.join(SERVER_DIR, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

const app = express();
// 放在反向代理後方時，讓 req.ip 取得真實來源 IP（速率限制依此計算）
if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ── API ──
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: APP_NAME, version: APP_VERSION });
});
app.use('/api/auth', authRouter);
app.use('/api/users', requireAuth, requireAdmin, usersRouter);
app.use('/api/brackets', requireAuth, bracketsRouter);
app.use('/api/payrolls', requireAuth, payrollsRouter);
app.use('/api/reports', requireAuth, reportsRouter);
// 未知 /api 路徑：未登入一律 401，已登入回 404
app.use('/api', requireAuth, (_req, res) => {
  res.status(404).json({ message: '找不到此 API' });
});

// ── 前端靜態檔與 SPA History Fallback ──
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  if (fs.existsSync(INDEX_HTML)) {
    res.sendFile(INDEX_HTML);
    return;
  }
  res.status(200).type('text/plain; charset=utf-8').send('HISP 後端已啟動；前端尚未建置（請執行 npm run build）。');
});
app.use((_req, res) => {
  res.status(404).json({ message: '找不到資源' });
});

// ── 全域錯誤處理：不外洩例外內容 ──
app.use(
  /**
   * @param {unknown} err
   * @param {import('express').Request} _req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} _next
   */
  (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ message: err.message });
      return;
    }
    // body-parser 的 JSON 格式錯誤
    if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
      res.status(400).json({ message: '請求內容格式錯誤' });
      return;
    }
    if (err instanceof Error && 'type' in err && err.type === 'entity.too.large') {
      res.status(413).json({ message: '請求內容過大' });
      return;
    }
    console.error('[error]', err);
    res.status(500).json({ message: '伺服器發生錯誤，請稍後再試' });
  },
);

try {
  await initDatabase();
} catch (err) {
  console.error('[db] 資料庫初始化失敗', err);
  process.exit(1);
}

app.listen(env.PORT, () => {
  console.log(`[server] ${APP_NAME} v${APP_VERSION} 已啟動：http://localhost:${env.PORT}（資料庫：${env.DB_DIALECT}）`);
});
