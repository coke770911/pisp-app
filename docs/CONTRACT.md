# HISP 前後端契約（hr-ins-split）

系統顯示名稱：`HISP - 人事勞健保加退拆帳系統`。年度一律為**民國年**（`new Date().getFullYear() - 1911`）。
單一入口 Port **9090**：Express 提供 `/api/*` 並託管 `server/public`（Vue build 輸出，SPA History Fallback）。

## 目錄
```
pisp-app/
├─ package.json            根目錄腳本（dev / build / start / typecheck / version:bump）
├─ .env / .env.example     （放根目錄，server 以 dotenv 讀取 ../.env）
├─ shared/splitCalc.js     逐筆疊加拆帳純函式（ESM，前後端共用；勿複製邏輯）
├─ server/                 Express + Sequelize（ESM, "type":"module"）
│  ├─ src/index.js         入口
│  ├─ src/config/database.js  依 DB_DIALECT=sqlite|mssql 切換
│  ├─ src/models/          InsuranceBracket, MonthlyPayroll, MonthlyPayrollItem
│  ├─ src/routes/          auth, brackets, payrolls, reports
│  ├─ src/middleware/      auth（session 驗證）、rateLimit
│  ├─ src/services/        excel 解析/輸出
│  └─ public/              前端 build 輸出（勿手動編輯）
└─ client/                 Vue 3 + Vite + vue-router（JS + JSDoc，`// @ts-check`）
```

## 編碼規範
- 純 JavaScript + JSDoc 型別 + `// @ts-check`（不得改寫成 TypeScript）。外部輸入用 zod 驗證。
- Sequelize：禁止 Raw SQL、禁止 `DataTypes.ENUM`；狀態欄位 `STRING(20)`；字串欄位一律明確長度。
- 寫入操作需防重複送出（前端 loading 鎖；後端以交易＋唯一約束／狀態條件更新）。

## 資料模型
### InsuranceBracket
`roc_year INTEGER`, `salary_limit INTEGER`, `labor_emp`, `labor_school`, `labor_occupational`, `pension_school`, `health_emp`, `health_school`（皆 INTEGER）。唯一複合索引 `(roc_year, salary_limit)`。

### MonthlyPayroll（月度人員投保主檔）
`roc_year INTEGER`, `month INTEGER(1~12)`, `employee_no STRING(20)`, `name STRING(50)`, `id_number STRING(20)`, `birthday STRING(20)`（原樣保存，例：民國 `0750101`）, `insurance_type STRING(10)`（`勞健`/`公健`）, `base_salary INTEGER`, `pension_rate INTEGER NOT NULL DEFAULT 0`（勞退自提率 %，0~6）, `status STRING(20)`（`draft`/`confirmed`）, `source_order INTEGER`（Excel 中首次出現順序，用於排序）。
**人員識別鍵 = 身分證號 `id_number`**（職員編號可能被修改，身分證號不變）。
- `id_number` 必填、儲存前 trim + 轉大寫、長度 ≤ 20。
- 唯一索引 `uq_monthly_payrolls_year_month_idno (roc_year, month, id_number)`。
- `employee_no` 為一般欄位（可修改）；同月內仍不得與他人重複（應用層檢查，非 DB 約束）。
- **遷移**（啟動時，僅用 QueryInterface API）：`showIndex` 若有舊索引 `uq_monthly_payrolls_year_month_emp` → `removeIndex`；既有資料的 `id_number` 以 ORM 讀出後 trim+大寫寫回；檢查同月是否有重複或空白身分證號——有衝突則 console.warn 列出（只列年月與筆數，不印身分證）並**略過**建立新唯一索引，伺服器照常啟動；無衝突則 `addIndex` 新唯一索引（已存在則略過）。
- **既有資料庫遷移**：`sync()` 不會新增欄位，啟動時須以 `queryInterface.describeTable()` 檢查，缺 `pension_rate` 時以 `queryInterface.addColumn()` 補上（INTEGER, allowNull false, defaultValue 0）。只用 Sequelize QueryInterface API，不寫 Raw SQL。

### MonthlyPayrollItem（逐筆疊加項目）
`payroll_id`（FK → MonthlyPayroll, onDelete CASCADE）, `source_name STRING(50)`, `amount INTEGER`, `sort_order INTEGER`（1, 2, 3…）。

## Excel 格式
### 級距表（7 欄，表頭在第 1 列）
`月投保金額`、`勞保費個人`、`勞保費學校(不含職災)`、`勞保費學校-職災`、`勞退金-學校`、`健保費-個人`、`健保費-學校`
- 表頭比對前先移除所有空白與換行（實際檔案中 `勞保費學校\n(不含職災)` 含換行），全形括號視為半形。
- 數值可能是 number 或 string（含千分位逗號），一律轉整數；空列略過。

### 個人所得明細（9 欄，直式）
`月份資料`、`職員編號`、`姓名`、`身分證號`、`生日`、`投保別`、`薪資來源`、`薪資`、`勞退自提`
- `勞退自提`：自提率數字（常用 `0`、`1`、`3`、`6`，代表 %；允許 0~6 整數，可能是 number 或字串，可帶 `%` 符號）。
  - **空白 = 未填**，預設 0%。
  - 同一人多列：取**有填寫的列中最高值**；全部未填則為 0（使用 `shared/splitCalc.js` 的 `mergePensionRates()`）。
  - 有填但不是 0~6 整數 → 400（列出列號）。
  - 舊版 8 欄檔（沒有 `勞退自提` 欄）仍可匯入，全部視為 0，並回傳 warning「檔案沒有勞退自提欄，已全部以 0% 計」。
- `月份資料` 形如 `11509`（民國年 + 2 位月份），`薪資` 可能為字串。
- 依 **`身分證號`**（trim + 大寫）歸戶。身分證號空白 → 400 列出列號。同一身分證號多列的職員編號／姓名／投保別不一致 → 以第一列為準並加 warning。不同身分證號使用同一職員編號 → 400（資料錯誤，列出職員編號與列號）。
- 歸戶後：`薪資來源 === '本薪'` 的列為 `base_salary`（若無則取該員第一筆）；其餘依出現順序成為 items（sort_order 1..N）。若同一人有多筆「本薪」，第一筆為基準，其餘當作加項。
- 匯入月份以使用者在畫面選擇的 year/month 為準；檔案中 `月份資料` 不一致時不拒絕，回傳 warnings（因為「匯出上月 → 修改 → 匯入本月」是正常流程）。
- 匯出（上月資料）使用相同 9 欄格式，`月份資料` 寫該筆資料自己的年月（例 `11509`），本薪一列 + 每個 item 一列；`勞退自提` 每一列都寫該人員的 pension_rate。

## 計算
- `勞健`：6 項保費全部計算。
- `公健`：只計健保（`health_emp`、`health_school`）；`labor_emp`、`labor_school`、`labor_occupational`、`pension_school` 一律為 0（`SplitResult.healthOnly = true`）。級距對照與逐筆疊加方式相同。
- **勞退自提** `pension_emp` = `Math.round(對照級距 salary_limit × pension_rate / 100)`，每一步依新級距重算、差額歸屬該薪資來源；計入 `emp_total`（個人合計）。公健一律 0。
- 顯示拆帳欄位用 `SPLIT_FEE_KEYS`（6 項 + `pension_emp`）；`FEE_KEYS` 僅指級距表 6 項（級距維護頁用）。

使用 `shared/splitCalc.js` 的 `computeSplit(person, sortBrackets(brackets))`，前端即時重算、後端報表重算，兩邊必須呼叫同一份程式。

## 認證（校內 portal API + 系統帳號白名單 + 4 位數字驗證碼）
舊的硬帳密（`ADMIN_USERNAME` / `ADMIN_PASSWORD`）**停用並移除程式碼**。

### 校內驗證 API（廠商 portal，REST）
- `POST ${PORTAL_AUTH_URL}`，Headers：`Content-Type: application/json`、`X-Auth-Key: ${PORTAL_API_KEY}`；body `{ "Account": "...", "Password": "..." }`。
- 回應：`{ Ok: boolean, Result: string, Code: string, DisplayName: string, Vendor, Timestamp }`（用 zod 驗證）。成功 = HTTP 200 且 `Ok === true`；`Code === 'INVALID_CREDENTIALS'`（或 Ok false 且 HTTP 200）= 帳密錯誤。
- 其他狀況（逾時 `PORTAL_TIMEOUT_MS` 預設 8000、網路錯誤、HTTP 400/401 API_KEY_INVALID/403 IP_DENIED/429/500/503、回應格式不符）→ 視為**服務故障**，登入回 503「服務暫時無法使用」，console.error 只記錄 HTTP 狀態與 Code（**不得記錄密碼、不得記錄 API 金鑰**）。
- `PORTAL_AUTH_URL` 或 `PORTAL_API_KEY` 未設定 → 登入回 503。API 金鑰只在後端使用，絕不送到前端。

### 系統帳號（白名單）
Model `SystemUser`（table `system_users`）：`account STRING(50)`（儲存前 trim + 轉小寫，唯一索引）、`display_name STRING(100)`（登入成功時以 portal DisplayName 更新）、`role STRING(20)`（`admin` / `user`）、`is_active BOOLEAN`（預設 true）、`created_by STRING(50)`、`last_login_at DATE`（可 null）。
- 只有存在且 `is_active` 的帳號能登入。
- 啟動時依 `BOOTSTRAP_ADMINS`（逗號分隔，例 `admin01`）確保這些帳號存在且為 active admin（已存在則升級為 admin 並啟用）。
- 管理 API 僅 `admin` 可用（非 admin → 403「權限不足」）。不可停用／刪除／降級自己；不可讓系統沒有任何 active admin（409「至少需保留一位啟用中的管理者」）。帳號被停用、刪除或降級時，清除該帳號所有 session（降級則更新 session 角色）。

### 驗證碼
- `GET /api/auth/captcha` → `{ captchaId, image }`（`image` 為 `data:image/svg+xml;base64,...`），`Cache-Control: no-store`。
- 4 位數字（0000–9999，crypto 隨機）；答案只存在伺服器記憶體 Map（captchaId = 16 bytes 隨機 hex），有效 `CAPTCHA_TTL_SECONDS`（預設 120）秒，**一次性**：登入時無論對錯都立即作廢。Map 定期清理並設上限（例如 5000 筆，超過先刪最舊）。
- SVG：數字以 `<path>` 畫出（不得用 `<text>`、不得在任何屬性／註解出現答案），每個字元隨機位移與旋轉，加干擾線與雜點。
- 速率限制：取驗證碼每 IP 每分鐘 `CAPTCHA_RATE_LIMIT`（預設 30）次 → 429。

### 登入流程 `POST /api/auth/login`
body `{ account, password, captchaId, captchaCode }`（zod 驗證；格式錯誤視同帳密錯誤回 401，但 captchaId/captchaCode 缺漏視同驗證碼錯誤）。
1. 速率限制（每 IP 每 15 分鐘 `LOGIN_RATE_LIMIT`）→ 429「嘗試次數過多，請稍後再試」。
2. **先驗驗證碼**（取出即刪除）：錯誤／過期／不存在 → 400 `{ message: '驗證碼錯誤或已過期', code: 'CAPTCHA_INVALID' }`。
3. 呼叫 portal 驗證帳密（**無論帳號是否在白名單都呼叫**，讓成本一致）。服務故障 → 503。
4. portal 失敗 **或** 帳號不在白名單／已停用 → 一律 401 `{ message: '帳號或密碼錯誤，或無此系統使用權限', code: 'INVALID_CREDENTIALS' }`。
5. 所有失敗回應（400/401/503）統一延遲到 `LOGIN_MIN_DELAY_MS`（預設 1500）下限。
6. 成功：更新 display_name、last_login_at，建立 session → 200 `{ account, displayName, role }`。
- Session：32 bytes 隨機 token、記憶體 Map、`SESSION_TTL_HOURS`、httpOnly + SameSite=Strict cookie `hisp_sid`（`COOKIE_SECURE=true` 加 Secure）。session 內存 account、displayName、role。
- 除 `/api/auth/login`、`/api/auth/captcha`、`/api/auth/me`、`/api/health` 外，所有 `/api/*` 需登入，否則 401 `{ message: '登入逾時，請重新登入' }`。

### 前端登入頁規則
- Enter 只由 `<form @submit.prevent>` 送出；不綁 `@keyup.enter`；送出函式 `if (loading) return`；「換一張」「顯示密碼」按鈕 `type="button"`。
- 驗證碼欄：`inputmode="numeric"`、`maxlength="4"`、`autocomplete="off"`、只允許數字。
- 每次送出後（成功或失敗）都換新驗證碼圖。
- 400 CAPTCHA_INVALID：保留帳號密碼、清空驗證碼、焦點移到驗證碼。401：清空密碼與驗證碼、焦點移到密碼。429/503：顯示後端 message。網路錯誤：「服務暫時無法使用」。
- 登入、取驗證碼請求標記略過全域 401 處理。
- 錯誤回應一律 `{ message: string }`，不得外洩例外內容（伺服器端 console.error 記錄即可）。

## API（皆以 JSON，除檔案上傳/下載）
| Method | Path | 說明 |
|---|---|---|
| GET | `/api/health` | `{ ok: true, name, version }` |
| GET | `/api/auth/captcha` | `{ captchaId, image }` / 429 |
| POST | `/api/auth/login` | body `{ account, password, captchaId, captchaCode }` → 200 `{ account, displayName, role }` / 400 CAPTCHA_INVALID / 401 / 429 / 503 |
| POST | `/api/auth/logout` | 200 `{ ok: true }` |
| GET | `/api/auth/me` | 200 `{ account, displayName, role }` / 401 |
| GET | `/api/users` | （admin）`SystemUser[]`：`{ id, account, display_name, role, is_active, created_by, last_login_at, createdAt }`，依 account 排序 |
| POST | `/api/users` | （admin）body `{ account, role }`（account 1~50 字，英數 `._-`，存小寫）；已存在 409「帳號已存在」→ 201 新帳號 |
| PUT | `/api/users/:id` | （admin）body `{ role?, is_active? }`；自我保護與最後一位管理者規則見上 → 更新後帳號 |
| DELETE | `/api/users/:id` | （admin）刪除帳號（同上保護）→ `{ ok: true }` |
| GET | `/api/brackets/years` | `number[]`（遞減） |
| GET | `/api/brackets?year=115` | `Bracket[]`（含 id、roc_year，依 salary_limit 遞增） |
| POST | `/api/brackets/import` | multipart: `file`, `year` → 交易內整年度覆蓋 → `{ year, count }`（可匯入任意年度，例如下年度 116） |
| DELETE | `/api/brackets?year=115` | 刪除整個年度級距 → `{ year, deleted }` |
| POST | `/api/brackets` | 新增單列 body `{ roc_year, salary_limit, labor_emp, labor_school, labor_occupational, pension_school, health_emp, health_school }`（皆非負整數）；同年度同 salary_limit 已存在回 409 `{ message: '該年度已有相同月投保金額' }` → 回傳新列 |
| PUT | `/api/brackets/:id` | 修改單列（欄位同上，roc_year 不可改）；salary_limit 與同年度其他列重複回 409 → 回傳更新列 |
| DELETE | `/api/brackets/:id` | 刪除單列 → `{ ok: true }` |
| POST | `/api/brackets/copy` | body `{ fromYear, toYear }` 複製整年度（目標年度已有資料回 409，需先刪除）→ `{ year: toYear, count }` |
| GET | `/api/brackets/export?year=115` | 下載 7 欄 xlsx（與匯入格式相同），檔名 `勞健保級距表_115年.xlsx`；無資料 404 |
| GET | `/api/payrolls/months` | `{ roc_year, month, status, count }[]`（年月遞減） |
| GET | `/api/payrolls?year=115&month=9` | `{ year, month, status: 'none'|'draft'|'confirmed', payrolls: Payroll[] }` |
| POST | `/api/payrolls/import` | multipart: `file`, `year`, `month` → 若該月已 confirmed 回 409；否則交易內整月覆蓋 → `{ year, month, count, laborCount, publicCount, warnings: string[] }` |
| GET | `/api/payrolls/export?year=115&month=8` | 下載 9 欄 xlsx（含勞退自提），檔名 `個人所得明細_115年08月.xlsx`（無資料回 404） |
| PUT | `/api/payrolls/:id` | body `{ employee_no, name, birthday, base_salary, insurance_type, pension_rate, items: [{ source_name, amount }] }`（employee_no 必填）（**身分證號不可改**，作為識別鍵；職員編號可改，與同月他人重複回 409「職員編號已被其他人員使用」）（items 順序即 sort_order）；該月 confirmed 回 409 → 回傳更新後 Payroll |
| POST | `/api/payrolls/copy` | body `{ fromYear, fromMonth, toYear, toMonth }`：把來源月份（不限狀態）所有人員與加項複製成目標月份 draft；目標月份已 confirmed 回 409；目標已有 draft 資料時需 body `overwrite: true` 否則 409 `{ message: '目標月份已有資料' }`；來源無資料 404 → `{ year, month, count }` |
| POST | `/api/payrolls` | 新增單一人員 body `{ year, month, employee_no, name, id_number, birthday, insurance_type, base_salary, pension_rate, items }`；該月 confirmed 回 409；同月身分證號重複回 409「本月已有此身分證號的人員」、職員編號與他人重複回 409「職員編號已被其他人員使用」 → 回傳 Payroll（source_order 取該月最大值 +1） |
| DELETE | `/api/payrolls/:id` | 刪除單一人員（含加項）；該月 confirmed 回 409 → `{ ok: true }` |
| POST | `/api/payrolls/confirm` | body `{ year, month }` → 條件更新 draft→confirmed（已 confirmed 也回 200，冪等）→ `{ status: 'confirmed' }` |
| POST | `/api/payrolls/reopen` | body `{ year, month }` → confirmed→draft → `{ status: 'draft' }` |
| GET | `/api/reports/split?year=115&month=9` | 下載拆帳報表 xlsx，檔名 `拆帳報表_115年09月.xlsx` |

`Payroll` 物件：
```json
{ "id": 1, "roc_year": 115, "month": 9, "employee_no": "A001", "name": "王小明",
  "id_number": "A123456789", "birthday": "0750101", "insurance_type": "勞健",
  "base_salary": 45000, "pension_rate": 6, "status": "draft",
  "items": [{ "id": 3, "source_name": "助理加給", "amount": 5000, "sort_order": 1 }] }
```
payrolls 依 `source_order` 排序；items 依 `sort_order`。
下載檔名使用 `Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent(name)>`。

## 拆帳報表（xlsx）
1. **逐筆拆帳明細**：每位人員每個 step 一列：職員編號、姓名、投保別、步驟（`Step 0 本薪` / `Step N`）、薪資來源、本筆金額、累計薪資、投保級距、6 項保費差額、勞退自提、自提率、個人合計、學校合計。公健者同樣逐筆列出，投保別顯示「公健（只計健保）」，勞保三項與勞退欄為 0、健保兩項照算。每人之後加粗小計列。
2. **薪資來源彙總**：依薪資來源名稱分組（本薪 = 所有 Step 0 diff 加總）：薪資來源、人次、薪資合計、6 項差額合計、個人合計、學校合計；最後一列總計。
3. **人員彙總**：每人一列：職員編號、姓名、投保別、本薪、總薪資、最終級距、6 項保費（最終）。
表頭粗體＋底色、凍結首列、金額千分位格式。
