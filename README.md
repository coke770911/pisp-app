# HISP - 人事勞健保加退拆帳系統（hr-ins-split）

目前版本：**0.1.4**

學校人事單位用的勞健保級距「逐筆疊加拆帳」系統：匯入年度級距表與每月個人所得明細，系統依身分證號歸戶，對每位人員逐筆累加薪資來源、重新對照級距，把保費差額拆給每一個薪資來源，並產出 Excel 拆帳報表。

## 功能
- **登入**：使用校內帳號密碼（呼叫學校 portal 驗證 API）＋ 4 位數字驗證碼；只有在「帳號管理」中新增且啟用的帳號才能登入。失敗一律回同一訊息與狀態碼、固定最短回應時間、每 IP 速率限制，避免帳號列舉。登入狀態採 **JWT**（HS256，放在 httpOnly + SameSite=Strict cookie）；停用／刪除帳號時其 JWT 立即失效，角色變更即時生效。
- **帳號管理**（管理者）：新增／停用／刪除系統帳號、設定管理者或一般使用者。`BOOTSTRAP_ADMINS` 指定的帳號啟動時自動成為管理者。
- **年度級距維護**：匯入 7 欄級距表到任一民國年度（可直接上傳下年度，整年度覆蓋）；刪除整個年度；線上新增／修改／刪除單列；複製本年度到下年度；匯出 xlsx 修改後再上傳。
- **月度投保資料匯入**：匯入 9 欄直式明細，依**身分證號**歸戶（職員編號可能變動，身分證號不變）；或匯出上個月已存檔資料（同 9 欄格式）修改後匯入本月。
- **投保別**：`勞健` 計算勞保、勞退、健保全部 6 項；`公健` 只計算健保（健保費-個人、健保費-學校），勞保三項與勞退金-學校一律為 0，標示「公健（只計健保）」。兩者都採相同的逐筆疊加拆帳。
- **逐筆疊加拆帳**：Step 0 本薪算基準保費 → 每多一個薪資來源就累加、重算級距、與前一階段相減，差額歸屬該來源（未跨級距為 0）。
- **每月沿用與比對**：一鍵沿用上個月資料，或下載上個月基本資料（9 欄 xlsx）檢查、修改後上傳；清單自動標示與上月相比的「新進」「本薪變動」「加項變動」，並列出上月有、本月無的人員；可新增／刪除人員，也可「刪除本月明細」整月清空後重新匯入（需輸入年月代碼確認；已確認月份需先重新開啟）。
- **線上工作台**：審視每人拆帳階梯，修改本薪、投保別，新增／刪除／調整順序其他薪資來源，即時重算。
- **確認歸檔與報表**：確認本月資料（供下月沿用），下載拆帳報表（逐筆拆帳明細、薪資來源彙總、人員彙總）。

## 拆帳規則
- 級距對照：取「月投保金額 ≥ 累計薪資」的最小級距；超過最高級距取最高級距。
- 個人合計 = 勞保費個人 + 健保費個人；學校合計 = 勞保學校(不含職災) + 職災 + 勞退學校 + 健保學校。
- 勞退自提：金額 = 四捨五入(對照級距 × 自提率%)，自提率常用 0、1、3、6（允許 0~6）；與其他保費一樣逐步重算、差額歸屬該薪資來源，並計入個人合計。公健無勞退，自提為 0。
- 公健人員：級距照樣對照，但勞保個人、勞保學校、職災、勞退一律為 0，只拆健保兩項。
- 該年度沒有級距資料時無法產出報表（請先匯入級距表）。
- 演算法位於 `shared/splitCalc.js`，前端即時試算與後端報表共用同一份程式。

## 技術棧
- 後端：Node.js + Express、Sequelize（SQLite 預設，可切換 SQL Server 2022）、exceljs、multer（memoryStorage）、zod
- 前端：Vue 3 + Vite + vue-router
- 型別：純 JavaScript + JSDoc + `// @ts-check`，以 `npm run typecheck` 檢查
- 單一 Port **9090**：Express 同時提供 `/api/*` 與 `server/public`（Vue 編譯檔，SPA History Fallback）

## 目錄結構
```
pisp-app/
├─ package.json         根目錄腳本
├─ .env.example         環境變數範本（複製成 .env）
├─ docs/CONTRACT.md     前後端契約（模型、API、Excel 格式、報表規格）
├─ shared/splitCalc.js  逐筆疊加拆帳演算法（前後端共用）
├─ scripts/bump-version.mjs  版本號遞增
├─ server/              Express 後端（public/ 為前端 build 輸出）
└─ client/              Vue 3 前端
```

## 安裝與執行
```powershell
npm run install:all
```
複製 `.env.example` 為 `.env`，**填入 `PORTAL_AUTH_URL`、`PORTAL_API_KEY`（向學校管理者索取）與 `BOOTSTRAP_ADMINS`（第一位管理者的校內帳號）**；未設定 portal 時登入會回「服務暫時無法使用」。校內驗證 API 有 IP 白名單，伺服器需在允許的校內網段。

正式運行（單一入口 http://localhost:9090）：
```powershell
npm run build
```
```powershell
npm start
```

開發模式（前端 Vite 會把 `/api` 代理到 9090）：
```powershell
npm run dev:server
```
```powershell
npm run dev:client
```

型別檢查：
```powershell
npm run typecheck
```

## 環境變數
| 鍵 | 說明 | 預設 |
|---|---|---|
| `PORT` | 伺服器 Port | `9090` |
| `DB_DIALECT` | `sqlite` 或 `mssql` | `sqlite` |
| `SQLITE_STORAGE` | SQLite 檔案（相對 server/） | `data/hisp.sqlite` |
| `MSSQL_HOST` / `MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD` | SQL Server 連線 | |
| `MSSQL_ENCRYPT` / `MSSQL_TRUST_SERVER_CERTIFICATE` | SQL Server 加密選項 | `true` |
| `SESSION_TTL_HOURS` | 登入（JWT）有效時數 | `8` |
| `JWT_SECRET` | JWT 簽章金鑰（機密，至少 32 字元隨機值；未設定時每次啟動產生臨時金鑰，重啟後需重新登入） | 空 |
| `COOKIE_SECURE` | HTTPS 部署時設 `true` | `false` |
| `LOGIN_MIN_DELAY_MS` | 登入失敗最短回應時間（毫秒） | `1500` |
| `LOGIN_RATE_LIMIT` | 每 IP 每 15 分鐘登入嘗試上限 | `10` |
| `PORTAL_AUTH_URL` | 校內驗證 REST 端點 | 空 |
| `PORTAL_API_KEY` | 校內驗證 API 金鑰（`X-Auth-Key`，機密） | 空 |
| `PORTAL_TIMEOUT_MS` | 呼叫校內 API 逾時（毫秒） | `8000` |
| `BOOTSTRAP_ADMINS` | 啟動時確保為管理者的帳號（逗號分隔） | 空 |
| `CAPTCHA_TTL_SECONDS` | 驗證碼有效秒數 | `120` |
| `CAPTCHA_RATE_LIMIT` | 每 IP 每分鐘取驗證碼上限 | `30` |
| `TRUST_PROXY` | 反向代理層數（IIS/nginx 後方設 `1`，速率限制才會依真實 IP） | `0` |

## Excel 格式
**年度級距表（7 欄）**：`月投保金額`、`勞保費個人`、`勞保費學校(不含職災)`、`勞保費學校-職災`、`勞退金-學校`、`健保費-個人`、`健保費-學校`（表頭中的換行與空白會自動忽略）。

**個人所得明細（9 欄）**：`月份資料`、`職員編號`、`姓名`、`身分證號`、`生日`、`投保別`、`薪資來源`、`薪資`、`勞退自提`
- `薪資來源 = 本薪` 為基準（無則取該員第一筆），其餘依 Excel 出現順序成為第 1、2、3… 個加項。
- **身分證號是人員識別鍵**：必填，自動去空白並轉大寫；同月不可重複。職員編號可在工作台修改（同月不可與他人重複），與上月比對時以身分證號配對並標示「職員編號變動」。
- 表頭寫「身份證號」的舊檔也能匯入（視同「身分證號」）；系統畫面與匯出一律使用「身分證號」。
- 匯入月份以畫面選擇為準；檔案的 `月份資料` 不同時只提示警告。
- `勞退自提` 填自提率數字（0、1、3、6，代表 %，可寫 `6%`）；**留空＝0%**。同一人多列時，取有填寫的列中**最高值**。舊版 8 欄檔仍可匯入（全部以 0% 計）。

## API 摘要
詳見 [docs/CONTRACT.md](docs/CONTRACT.md)。

| Method | Path | 說明 |
|---|---|---|
| GET/POST | `/api/auth/captcha`、`/api/auth/login`、`/api/auth/logout`、GET `/api/auth/me` | 驗證碼／登入／登出／目前使用者 |
| GET/POST/PUT/DELETE | `/api/users`、`/api/users/:id` | 帳號管理（管理者） |
| GET/POST | `/api/brackets`、`/api/brackets/years`、`/api/brackets/import` | 級距查詢、新增單列、匯入 |
| PUT/DELETE | `/api/brackets/:id`、DELETE `/api/brackets?year=` | 修改／刪除單列、刪除整年度 |
| POST/GET | `/api/brackets/copy`、`/api/brackets/export` | 複製年度、匯出 xlsx |
| GET | `/api/payrolls`、`/api/payrolls/months`、`/api/payrolls/export` | 月度資料查詢與匯出 |
| POST | `/api/payrolls/import`、`/api/payrolls/confirm`、`/api/payrolls/reopen` | 匯入、確認、重新開啟 |
| PUT | `/api/payrolls/:id` | 修改本薪、投保別、加項 |
| DELETE | `/api/payrolls?year=&month=` | 刪除整月明細以便重新匯入（已確認月份需先重新開啟） |
| GET | `/api/reports/split` | 下載拆帳報表 |

## 年度
全系統採民國年（`西元年 - 1911`，2026 年 = 115 年）。

## 版本號
```powershell
npm run version:bump
```
規則：`z` 每次 +1，超過 30 歸零並 `y` +1；`y` 超過 20 歸零並 `x` +1。
