<script setup>
// @ts-check
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { computeSplit, sortBrackets, currentRocYear, normalizePensionRate } from '@shared/splitCalc.js';
import PersonEditor from '../components/PersonEditor.vue';
import {
  fetchPayrolls,
  fetchBrackets,
  importPayrolls,
  confirmMonth,
  reopenMonth,
  copyPayrolls,
  deletePayroll,
  downloadPayrollExport,
  downloadSplitReport,
} from '../api/index.js';
import { ApiError, errorMessage } from '../api/http.js';
import { formatNumber, previousMonth, toInt } from '../utils/format.js';
import { compareWithPrevious, indexByEmployeeNo, missingInCurrent, NO_CHANGE } from '../utils/compare.js';
import { askConfirm, toast } from '../stores/dialog.js';
import { authState } from '../stores/auth.js';

/** @typedef {import('../api/schemas.js').Payroll} Payroll */
/** @typedef {import('../api/schemas.js').MonthStatus} MonthStatus */
/** @typedef {import('../api/schemas.js').PayrollImportResult} PayrollImportResult */
/** @typedef {import('@shared/splitCalc.js').Bracket} Bracket */
/** @typedef {import('@shared/splitCalc.js').SplitResult} SplitResult */
/** @typedef {import('../utils/compare.js').ChangeFlags} ChangeFlags */

/**
 * 清單列
 * @typedef {Object} PersonRow
 * @property {Payroll} p
 * @property {SplitResult} split
 * @property {number} totalSalary
 * @property {number} finalLimit
 * @property {number} pensionRate 勞退自提率（%，已正規化）
 * @property {ChangeFlags} change
 */

/** @typedef {'all' | '勞健' | '公健'} TypeFilter */
/** @typedef {'all' | 'changed' | 'new' | 'base' | 'items' | 'pension'} ChangeFilter */

/** 編輯面板目標：既有人員 id 或新增 */
/** @typedef {{ mode: 'edit', id: number } | { mode: 'new' }} EditorTarget */

/** @type {Readonly<Record<MonthStatus, string>>} */
const STATUS_LABELS = Object.freeze({ none: '無資料', draft: '審核中', confirmed: '已確認' });

const MONTHS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const route = useRoute();
const router = useRouter();

/* ---------- 年月選擇 ---------- */

/**
 * 從網址 query 取得初始年月（無效時用當月）。
 * @returns {{ year: number, month: number }}
 */
function initialPeriod() {
  const now = new Date();
  const qy = typeof route.query.year === 'string' ? toInt(route.query.year) : null;
  const qm = typeof route.query.month === 'string' ? toInt(route.query.month) : null;
  return {
    year: qy !== null && qy > 0 && qy < 1000 ? qy : currentRocYear(now),
    month: qm !== null && qm >= 1 && qm <= 12 ? qm : now.getMonth() + 1,
  };
}

const init = initialPeriod();
const year = ref(init.year);
const month = ref(init.month);
/** 年度輸入框（字串） */
const yearInput = ref(String(init.year));

/** 上個月（1 月 → 去年 12 月） */
const prev = computed(() => previousMonth(year.value, month.value));
const prevLabel = computed(() => `${prev.value.year} 年 ${prev.value.month} 月`);
const curLabel = computed(() => `${year.value} 年 ${month.value} 月`);

/* ---------- 資料 ---------- */

/** @type {import('vue').Ref<MonthStatus>} */
const status = ref('none');
/** @type {import('vue').Ref<Payroll[]>} */
const payrolls = ref([]);
/** @type {import('vue').Ref<Payroll[]>} */
const prevPayrolls = ref([]);
/** 上月資料是否載入失敗 */
const prevLoadFailed = ref(false);
/** @type {import('vue').Ref<Bracket[]>} 已排序級距 */
const sortedBrackets = ref([]);
/** @type {import('vue').Ref<number | null>} 已載入級距的年度 */
const bracketYear = ref(null);
const bracketError = ref('');

const loading = ref(false);
const loadError = ref('');
let loadSeq = 0;

/** @type {import('vue').Ref<PayrollImportResult | null>} 最近一次匯入結果 */
const importResult = ref(null);

/* ---------- 寫入狀態（防重複送出） ---------- */
const importing = ref(false);
const copying = ref(false);
const confirming = ref(false);
const reopening = ref(false);
/** @type {import('vue').Ref<number | null>} */
const deletingId = ref(null);
const downloadingPrev = ref(false);
const downloadingCur = ref(false);
const downloadingReport = ref(false);

const busy = computed(
  () => importing.value || copying.value || confirming.value || reopening.value || deletingId.value !== null,
);
const isConfirmed = computed(() => status.value === 'confirmed');

/* ---------- 篩選 ---------- */
const search = ref('');
/** @type {import('vue').Ref<TypeFilter>} */
const typeFilter = ref('all');
/** @type {import('vue').Ref<ChangeFilter>} */
const changeFilter = ref('all');

/* ---------- 編輯面板 ---------- */
/** @type {import('vue').Ref<EditorTarget | null>} */
const editor = ref(null);
const editorDirty = ref(false);

/** @type {import('vue').Ref<HTMLInputElement | null>} */
const fileInput = ref(null);

/* ---------- 衍生資料 ---------- */

const prevIndex = computed(() => indexByEmployeeNo(prevPayrolls.value));

/** 是否有上月資料可比對 */
const hasPrev = computed(() => prevPayrolls.value.length > 0);

/** @type {import('vue').ComputedRef<PersonRow[]>} */
const rows = computed(() =>
  payrolls.value.map((p) => {
    const pensionRate = normalizePensionRate(p.pension_rate);
    const split = computeSplit({ ...p, pension_rate: pensionRate }, sortedBrackets.value);
    const last = split.steps.length > 0 ? split.steps[split.steps.length - 1] : null;
    return {
      p,
      split,
      totalSalary: last ? last.cumulative : 0,
      finalLimit: last ? last.salary_limit : 0,
      pensionRate,
      // 上月完全無資料時不標示變動
      change: hasPrev.value ? compareWithPrevious(p, prevIndex.value.get(p.employee_no)) : NO_CHANGE,
    };
  }),
);

/** @type {import('vue').ComputedRef<PersonRow[]>} */
const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (typeFilter.value !== 'all' && r.p.insurance_type !== typeFilter.value) return false;
    if (changeFilter.value === 'changed' && !r.change.any) return false;
    if (changeFilter.value === 'new' && !r.change.isNew) return false;
    if (changeFilter.value === 'base' && !r.change.baseChanged) return false;
    if (changeFilter.value === 'items' && !r.change.itemsChanged) return false;
    if (changeFilter.value === 'pension' && !r.change.pensionChanged) return false;
    if (q !== '' && !r.p.employee_no.toLowerCase().includes(q) && !r.p.name.toLowerCase().includes(q)) return false;
    return true;
  });
});

/** 整月彙總（前端計算） */
const summary = computed(() => {
  let labor = 0;
  let pub = 0;
  let emp = 0;
  let school = 0;
  let pension = 0;
  let changed = 0;
  for (const r of rows.value) {
    if (r.p.insurance_type === '勞健') labor += 1;
    else pub += 1;
    emp += r.split.total.emp_total;
    school += r.split.total.school_total;
    pension += r.split.total.pension_emp;
    if (r.change.any) changed += 1;
  }
  return { labor, pub, emp, school, pension, changed };
});

/** 上月有、本月無 */
const missingPeople = computed(() => (status.value === 'none' ? [] : missingInCurrent(prevPayrolls.value, payrolls.value)));

/** 該年度無級距 */
const bracketMissingWarn = computed(
  () => bracketYear.value === year.value && sortedBrackets.value.length === 0 && !bracketError.value,
);

/** 編輯中的人員 */
const editingPayroll = computed(() => {
  const e = editor.value;
  if (!e || e.mode !== 'edit') return null;
  const id = e.id;
  return payrolls.value.find((p) => p.id === id) ?? null;
});

/** 編輯中人員的上月資料 */
const editingPrevious = computed(() => {
  const p = editingPayroll.value;
  return p ? (prevIndex.value.get(p.employee_no) ?? null) : null;
});

/* ---------- 載入 ---------- */

/**
 * @param {number} y
 * @returns {Promise<void>}
 */
async function loadBracketsFor(y) {
  if (bracketYear.value === y && !bracketError.value) return;
  try {
    const list = await fetchBrackets(y);
    if (year.value !== y) return;
    sortedBrackets.value = sortBrackets(list);
    bracketYear.value = y;
    bracketError.value = '';
  } catch (err) {
    if (year.value !== y) return;
    sortedBrackets.value = [];
    bracketYear.value = y;
    bracketError.value = errorMessage(err);
  }
}

/** @returns {Promise<void>} */
async function loadPrevious() {
  const p = prev.value;
  try {
    const data = await fetchPayrolls(p.year, p.month);
    prevPayrolls.value = data.payrolls;
    prevLoadFailed.value = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    prevPayrolls.value = [];
    prevLoadFailed.value = true;
  }
}

/** @returns {Promise<void>} */
async function loadAll() {
  const seq = ++loadSeq;
  const y = year.value;
  const m = month.value;
  loading.value = true;
  loadError.value = '';
  try {
    const [cur] = await Promise.all([fetchPayrolls(y, m), loadPrevious(), loadBracketsFor(y)]);
    if (seq !== loadSeq) return;
    status.value = cur.status;
    payrolls.value = cur.payrolls;
  } catch (err) {
    if (seq !== loadSeq) return;
    loadError.value = errorMessage(err);
    status.value = 'none';
    payrolls.value = [];
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

/** 只重新載入本月（寫入後使用） */
async function reloadCurrent() {
  try {
    const cur = await fetchPayrolls(year.value, month.value);
    status.value = cur.status;
    payrolls.value = cur.payrolls;
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

/**
 * 有未儲存編輯時詢問。
 * @returns {Promise<boolean>} true = 可繼續
 */
async function confirmDiscardEditor() {
  if (!editor.value || !editorDirty.value) return true;
  return askConfirm({
    title: '尚未儲存',
    message: '目前編輯中的人員資料尚未儲存，確定要放棄變更？',
    confirmText: '放棄變更',
    danger: true,
  });
}

/**
 * 切換年月。
 * @param {number} y
 * @param {number} m
 * @returns {Promise<void>}
 */
async function changePeriod(y, m) {
  if (!(await confirmDiscardEditor())) {
    yearInput.value = String(year.value);
    return;
  }
  editor.value = null;
  editorDirty.value = false;
  importResult.value = null;
  year.value = y;
  month.value = m;
  yearInput.value = String(y);
  void router.replace({ query: { ...route.query, year: String(y), month: String(m) } });
  await loadAll();
}

/** @returns {Promise<void>} */
async function onYearSubmit() {
  const y = toInt(yearInput.value);
  if (y === null || y < 1 || y > 999) {
    toast('請輸入有效的民國年（例：115）', 'warning');
    yearInput.value = String(year.value);
    return;
  }
  if (y !== year.value) await changePeriod(y, month.value);
}

/**
 * @param {Event} e
 * @returns {Promise<void>}
 */
async function onMonthChange(e) {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  const m = toInt(sel.value);
  sel.value = String(month.value);
  // 年度輸入框若已改為有效年度但尚未按 Enter，一併套用
  const yi = toInt(yearInput.value);
  const y = yi !== null && yi > 0 && yi < 1000 ? yi : year.value;
  if (m !== null && (m !== month.value || y !== year.value)) await changePeriod(y, m);
}

/**
 * 前後月切換。
 * @param {-1 | 1} dir
 * @returns {Promise<void>}
 */
async function shiftMonth(dir) {
  let y = year.value;
  let m = month.value + dir;
  if (m < 1) {
    m = 12;
    y -= 1;
  } else if (m > 12) {
    m = 1;
    y += 1;
  }
  await changePeriod(y, m);
}

/* ---------- 匯入 / 沿用 / 下載 ---------- */

/** @returns {void} */
function pickImportFile() {
  if (busy.value || isConfirmed.value) return;
  fileInput.value?.click();
}

/**
 * @param {Event} e
 * @returns {Promise<void>}
 */
async function onImportFile(e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const file = input.files && input.files.length > 0 ? input.files[0] : null;
  input.value = '';
  if (!file || importing.value) return;
  if (!(await confirmDiscardEditor())) return;
  const hasData = status.value !== 'none';
  const ok = await askConfirm({
    title: '匯入個人所得明細',
    message: hasData
      ? `${curLabel.value} 已有 ${payrolls.value.length} 位人員資料，匯入「${file.name}」將整月覆蓋（含已編輯的內容），確定繼續？`
      : `確定將「${file.name}」匯入為 ${curLabel.value} 資料？`,
    confirmText: hasData ? '覆蓋匯入' : '匯入',
    danger: hasData,
  });
  if (!ok) return;
  importing.value = true;
  try {
    editor.value = null;
    editorDirty.value = false;
    const result = await importPayrolls(year.value, month.value, file);
    importResult.value = result;
    toast(`已匯入 ${formatNumber(result.count)} 人（勞健 ${result.laborCount}、公健 ${result.publicCount}）`, 'success');
    await reloadCurrent();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    importing.value = false;
  }
}

/** @returns {Promise<void>} */
async function onCopyPrevious() {
  if (copying.value || isConfirmed.value) return;
  if (!(await confirmDiscardEditor())) return;
  const hasData = status.value === 'draft';
  const ok = await askConfirm({
    title: '沿用上個月資料',
    message: hasData
      ? `${curLabel.value} 已有 ${payrolls.value.length} 位人員資料，沿用 ${prevLabel.value} 資料將整月覆蓋，確定繼續？`
      : `將 ${prevLabel.value} 的 ${prevPayrolls.value.length} 位人員與加項複製為 ${curLabel.value}（審核中），確定繼續？`,
    confirmText: hasData ? '覆蓋沿用' : '沿用',
    danger: hasData,
  });
  if (!ok) return;
  copying.value = true;
  try {
    editor.value = null;
    editorDirty.value = false;
    importResult.value = null;
    const result = await copyPayrolls(prev.value, { year: year.value, month: month.value }, hasData);
    toast(`已沿用 ${prevLabel.value} 資料 ${formatNumber(result.count)} 人`, 'success');
    await reloadCurrent();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    copying.value = false;
  }
}

/** @returns {Promise<void>} */
async function onDownloadPrev() {
  if (downloadingPrev.value) return;
  downloadingPrev.value = true;
  try {
    const name = await downloadPayrollExport(prev.value.year, prev.value.month);
    toast(`已下載 ${name}`, 'success');
  } catch (err) {
    toast(err instanceof ApiError && err.status === 404 ? `${prevLabel.value} 無已存檔資料` : errorMessage(err), 'error');
  } finally {
    downloadingPrev.value = false;
  }
}

/** @returns {Promise<void>} */
async function onDownloadCurrent() {
  if (downloadingCur.value) return;
  if (editorDirty.value) toast('編輯中的變更尚未儲存，下載內容為已存檔資料', 'warning');
  downloadingCur.value = true;
  try {
    const name = await downloadPayrollExport(year.value, month.value);
    toast(`已下載 ${name}`, 'success');
  } catch (err) {
    toast(err instanceof ApiError && err.status === 404 ? `${curLabel.value} 無資料` : errorMessage(err), 'error');
  } finally {
    downloadingCur.value = false;
  }
}

/** @returns {Promise<void>} */
async function onDownloadReport() {
  if (downloadingReport.value) return;
  if (editorDirty.value) toast('編輯中的變更尚未儲存，報表以已存檔資料計算', 'warning');
  downloadingReport.value = true;
  try {
    const name = await downloadSplitReport(year.value, month.value);
    toast(`已下載 ${name}`, 'success');
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    downloadingReport.value = false;
  }
}

/* ---------- 確認 / 重新開啟 ---------- */

/** @returns {Promise<void>} */
async function onConfirmMonth() {
  if (confirming.value) return;
  if (!(await confirmDiscardEditor())) return;
  const ok = await askConfirm({
    title: '確認儲存本月',
    message: `確認 ${curLabel.value} 共 ${payrolls.value.length} 位人員資料？確認後將鎖定編輯（可再「重新開啟編輯」）。`,
    confirmText: '確認儲存',
  });
  if (!ok) return;
  confirming.value = true;
  try {
    editor.value = null;
    editorDirty.value = false;
    const res = await confirmMonth(year.value, month.value);
    status.value = res.status;
    toast(`${curLabel.value} 已確認`, 'success');
    await reloadCurrent();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    confirming.value = false;
  }
}

/** @returns {Promise<void>} */
async function onReopen() {
  if (reopening.value) return;
  const ok = await askConfirm({
    title: '重新開啟編輯',
    message: `將 ${curLabel.value} 改回「審核中」以便修改，確定繼續？`,
    confirmText: '重新開啟',
  });
  if (!ok) return;
  reopening.value = true;
  try {
    const res = await reopenMonth(year.value, month.value);
    status.value = res.status;
    toast(`${curLabel.value} 已重新開啟編輯`, 'success');
    await reloadCurrent();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    reopening.value = false;
  }
}

/* ---------- 人員 ---------- */

/**
 * @param {EditorTarget} target
 * @returns {Promise<void>}
 */
async function openEditor(target) {
  const cur = editor.value;
  if (cur && cur.mode === target.mode && (cur.mode === 'new' || (target.mode === 'edit' && cur.id === target.id))) return;
  if (!(await confirmDiscardEditor())) return;
  editorDirty.value = false;
  editor.value = target;
}

/** @returns {Promise<void>} */
async function closeEditor() {
  if (!(await confirmDiscardEditor())) return;
  editor.value = null;
  editorDirty.value = false;
}

/**
 * @param {Payroll} saved
 * @param {boolean} created
 * @returns {void}
 */
function onSaved(saved, created) {
  if (created) {
    payrolls.value = [...payrolls.value, saved];
    if (status.value === 'none') status.value = 'draft';
    editorDirty.value = false;
    editor.value = { mode: 'edit', id: saved.id };
  } else {
    payrolls.value = payrolls.value.map((p) => (p.id === saved.id ? saved : p));
  }
}

/**
 * @param {Payroll} p
 * @returns {Promise<void>}
 */
async function onDeletePerson(p) {
  if (deletingId.value !== null || isConfirmed.value) return;
  const ok = await askConfirm({
    title: '刪除人員',
    message: `確定從 ${curLabel.value} 刪除 ${p.employee_no} ${p.name}（含所有加項）？`,
    confirmText: '刪除',
    danger: true,
  });
  if (!ok) return;
  deletingId.value = p.id;
  try {
    await deletePayroll(p.id);
    const e = editor.value;
    if (e && e.mode === 'edit' && e.id === p.id) {
      editor.value = null;
      editorDirty.value = false;
    }
    toast(`已刪除 ${p.employee_no} ${p.name}`, 'success');
    await reloadCurrent();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    deletingId.value = null;
  }
}

/**
 * @param {PersonRow} r
 * @returns {boolean}
 */
function isRowActive(r) {
  const e = editor.value;
  return e !== null && e.mode === 'edit' && e.id === r.p.id;
}

/* ---------- 離開提示 ---------- */

/**
 * @param {BeforeUnloadEvent} e
 * @returns {void}
 */
function onBeforeUnload(e) {
  if (editor.value && editorDirty.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}

onBeforeRouteLeave(async () => {
  // 登入逾時導向時不提示
  if (authState.username === null) return true;
  return confirmDiscardEditor();
});

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload);
  void loadAll();
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <section class="page">
    <!-- 年月與狀態 -->
    <div class="page-head">
      <h2 class="page-title">月度工作台</h2>
      <div class="period-picker">
        <button type="button" class="btn btn-sm" title="上個月" :disabled="loading" @click="shiftMonth(-1)">◀</button>
        <form class="inline-form" @submit.prevent="onYearSubmit">
          <label class="inline-field">
            <span>民國</span>
            <input
              v-model="yearInput"
              class="input input-year"
              inputmode="numeric"
              maxlength="3"
              aria-label="民國年"
            />
            <span>年</span>
          </label>
        </form>
        <select class="input input-select" :value="month" aria-label="月份" @change="onMonthChange">
          <option v-for="m in MONTHS" :key="m" :value="m">{{ m }} 月</option>
        </select>
        <button type="button" class="btn btn-sm" title="下個月" :disabled="loading" @click="shiftMonth(1)">▶</button>
        <span class="status-badge" :class="`status-${status}`">{{ STATUS_LABELS[status] }}</span>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="loadAll">重新整理</button>
      </div>
    </div>

    <!-- 工具列 -->
    <div class="toolbar card">
      <div class="toolbar-group">
        <input
          ref="fileInput"
          type="file"
          class="hidden-file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          @change="onImportFile"
        />
        <button type="button" class="btn" :disabled="busy || loading || isConfirmed" @click="pickImportFile">
          {{ importing ? '匯入中…' : '上傳明細 xlsx' }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="busy || loading || isConfirmed || !hasPrev"
          :title="hasPrev ? '' : `${prevLabel} 無資料`"
          @click="onCopyPrevious"
        >
          {{ copying ? '沿用中…' : '沿用上個月資料' }}
        </button>
        <button type="button" class="btn" :disabled="busy || loading || isConfirmed" @click="openEditor({ mode: 'new' })">
          ＋ 新增人員
        </button>
      </div>
      <div class="toolbar-group">
        <button type="button" class="btn" :disabled="downloadingPrev" @click="onDownloadPrev">
          {{ downloadingPrev ? '下載中…' : `下載上個月基本資料（${prev.month} 月）` }}
        </button>
        <button type="button" class="btn" :disabled="downloadingCur || status === 'none'" @click="onDownloadCurrent">
          {{ downloadingCur ? '下載中…' : '下載本月資料' }}
        </button>
        <button type="button" class="btn" :disabled="downloadingReport || status === 'none'" @click="onDownloadReport">
          {{ downloadingReport ? '下載中…' : '下載拆帳報表' }}
        </button>
        <button
          v-if="!isConfirmed"
          type="button"
          class="btn btn-primary"
          :disabled="busy || loading || status === 'none'"
          @click="onConfirmMonth"
        >
          {{ confirming ? '確認中…' : '確認儲存本月' }}
        </button>
        <button v-else type="button" class="btn btn-warning" :disabled="busy || loading" @click="onReopen">
          {{ reopening ? '處理中…' : '重新開啟編輯' }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="alert alert-error">{{ loadError }}</div>
    <div v-if="bracketError" class="alert alert-error">級距資料載入失敗：{{ bracketError }}</div>
    <div v-else-if="bracketMissingWarn" class="alert alert-warning">
      {{ year }} 年度尚無級距資料，無法計算拆帳。請先至
      <RouterLink to="/brackets">年度級距維護</RouterLink> 匯入或複製級距。
    </div>
    <div v-if="isConfirmed" class="alert alert-info">{{ curLabel }} 已確認，資料為唯讀；如需修改請按「重新開啟編輯」。</div>

    <!-- 匯入警告 -->
    <div v-if="importResult && importResult.warnings.length > 0" class="alert alert-warning">
      <div class="alert-head">
        <strong>匯入提醒（{{ importResult.warnings.length }} 則）</strong>
        <button type="button" class="btn btn-ghost btn-sm" @click="importResult = null">關閉</button>
      </div>
      <ul class="warning-list">
        <li v-for="(w, i) in importResult.warnings" :key="i">{{ w }}</li>
      </ul>
    </div>

    <!-- 無資料：起始區塊 -->
    <div v-if="!loading && !loadError && status === 'none'" class="start-panel card">
      <h3>{{ curLabel }} 尚無資料，請選擇開始方式</h3>
      <div class="start-options">
        <div class="start-option">
          <div class="start-num">A</div>
          <h4>沿用上個月資料</h4>
          <p class="muted">
            將 {{ prevLabel }} 的人員、本薪與加項直接複製為本月（審核中），再逐人調整。
            <template v-if="hasPrev">上月共 {{ prevPayrolls.length }} 人。</template>
            <template v-else>（{{ prevLabel }} 無資料）</template>
          </p>
          <button type="button" class="btn btn-primary" :disabled="busy || !hasPrev" @click="onCopyPrevious">
            {{ copying ? '沿用中…' : '沿用上個月資料' }}
          </button>
        </div>
        <div class="start-option">
          <div class="start-num">B</div>
          <h4>下載上個月基本資料檢查</h4>
          <p class="muted">下載 {{ prevLabel }} 的 9 欄明細 xlsx（含勞退自提），在 Excel 修改後以「上傳明細 xlsx」匯入本月。</p>
          <button type="button" class="btn" :disabled="downloadingPrev" @click="onDownloadPrev">
            {{ downloadingPrev ? '下載中…' : '下載上個月基本資料' }}
          </button>
        </div>
        <div class="start-option">
          <div class="start-num">C</div>
          <h4>上傳明細 xlsx</h4>
          <p class="muted">9 欄格式（含勞退自提，可留空＝0%）：月份資料、職員編號、姓名、身份證號、生日、投保別、薪資來源、薪資、勞退自提。</p>
          <button type="button" class="btn" :disabled="busy" @click="pickImportFile">
            {{ importing ? '匯入中…' : '上傳明細 xlsx' }}
          </button>
        </div>
      </div>
    </div>

    <template v-if="status !== 'none'">
      <!-- 彙總 -->
      <div class="summary-cards">
        <div class="summary-card">
          <div class="summary-label">勞健人數</div>
          <div class="summary-num">{{ formatNumber(summary.labor) }}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">公健人數（只計健保）</div>
          <div class="summary-num">{{ formatNumber(summary.pub) }}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">個人負擔合計</div>
          <div class="summary-num">{{ formatNumber(summary.emp) }}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">學校負擔合計</div>
          <div class="summary-num">{{ formatNumber(summary.school) }}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">勞退自提合計</div>
          <div class="summary-num">{{ formatNumber(summary.pension) }}</div>
        </div>
        <div class="summary-card">
          <div class="summary-label">與 {{ prevLabel }} 相比</div>
          <div class="summary-num summary-num-sm">
            <template v-if="hasPrev">變動 {{ summary.changed }}／離職異動 {{ missingPeople.length }}</template>
            <template v-else-if="prevLoadFailed">上月資料載入失敗</template>
            <template v-else>上月無資料</template>
          </div>
        </div>
      </div>

      <!-- 上月有、本月無 -->
      <div v-if="missingPeople.length > 0" class="alert alert-info">
        <strong>{{ prevLabel }}有、本月無（離職／異動）共 {{ missingPeople.length }} 人：</strong>
        <span v-for="p in missingPeople" :key="p.employee_no" class="missing-person">
          {{ p.employee_no }} {{ p.name }}
        </span>
      </div>

      <!-- 篩選 -->
      <div class="filter-bar">
        <input v-model="search" class="input input-search" placeholder="搜尋職員編號或姓名" aria-label="搜尋" />
        <select v-model="typeFilter" class="input input-select" aria-label="投保別篩選">
          <option value="all">全部投保別</option>
          <option value="勞健">勞健</option>
          <option value="公健">公健</option>
        </select>
        <select v-model="changeFilter" class="input input-select" aria-label="變動篩選" :disabled="!hasPrev">
          <option value="all">全部人員</option>
          <option value="changed">只看有變動</option>
          <option value="new">新進</option>
          <option value="base">本薪變動</option>
          <option value="items">加項變動</option>
          <option value="pension">自提率變動</option>
        </select>
        <span class="muted">顯示 {{ filteredRows.length }}／{{ rows.length }} 人</span>
      </div>

      <!-- 人員清單 -->
      <div class="card">
        <div class="table-wrap">
          <table class="table table-hover">
            <thead>
              <tr>
                <th>職員編號</th>
                <th>姓名</th>
                <th>投保別</th>
                <th class="num">自提率</th>
                <th>與上月比對</th>
                <th class="num">本薪</th>
                <th class="num">加項數</th>
                <th class="num">總薪資</th>
                <th class="num">最終級距</th>
                <th class="num">個人合計</th>
                <th class="num">學校合計</th>
                <th style="width: 120px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="filteredRows.length === 0">
                <td colspan="12" class="empty-row">沒有符合條件的人員</td>
              </tr>
              <tr
                v-for="r in filteredRows"
                :key="r.p.id"
                class="clickable"
                :class="{ 'row-active': isRowActive(r) }"
                @click="openEditor({ mode: 'edit', id: r.p.id })"
              >
                <td class="mono">{{ r.p.employee_no }}</td>
                <td>{{ r.p.name }}</td>
                <td>
                  <span v-if="r.p.insurance_type === '公健'" class="tag tag-public">公健（只計健保）</span>
                  <span v-else class="tag tag-labor">勞健</span>
                </td>
                <td class="num" :class="{ 'rate-zero': r.pensionRate === 0 }">{{ r.pensionRate }}%</td>
                <td class="nowrap">
                  <span v-if="r.change.isNew" class="tag tag-new">新進</span>
                  <span v-if="r.change.baseChanged" class="tag tag-change">本薪變動</span>
                  <span v-if="r.change.itemsChanged" class="tag tag-change">加項變動</span>
                  <span v-if="r.change.typeChanged" class="tag tag-change">投保別變動</span>
                  <span v-if="r.change.pensionChanged" class="tag tag-change">自提率變動</span>
                </td>
                <td class="num">{{ formatNumber(r.p.base_salary) }}</td>
                <td class="num">{{ r.p.items.length }}</td>
                <td class="num">{{ formatNumber(r.totalSalary) }}</td>
                <td class="num">{{ r.split.bracketMissing ? '—' : formatNumber(r.finalLimit) }}</td>
                <td class="num">{{ formatNumber(r.split.total.emp_total) }}</td>
                <td class="num">{{ formatNumber(r.split.total.school_total) }}</td>
                <td class="nowrap" @click.stop>
                  <button type="button" class="btn btn-sm" @click="openEditor({ mode: 'edit', id: r.p.id })">
                    {{ isConfirmed ? '檢視' : '編輯' }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-danger-outline"
                    :disabled="busy || isConfirmed"
                    @click="onDeletePerson(r.p)"
                  >
                    {{ deletingId === r.p.id ? '刪除中…' : '刪除' }}
                  </button>
                </td>
              </tr>
            </tbody>
            <tfoot v-if="rows.length > 0">
              <tr>
                <td colspan="9">全月合計（{{ rows.length }} 人）</td>
                <td class="num">{{ formatNumber(summary.emp) }}</td>
                <td class="num">{{ formatNumber(summary.school) }}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </template>

    <div v-if="loading" class="muted loading-line">載入中…</div>

    <!-- 編輯側欄 -->
    <div v-if="editor && (editor.mode === 'new' || editingPayroll)" class="drawer-backdrop" @click.self="closeEditor">
      <aside class="drawer" aria-label="人員編輯">
        <PersonEditor
          :key="editor.mode === 'edit' ? `e${editor.id}` : 'new'"
          :payroll="editingPayroll"
          :year="year"
          :month="month"
          :previous="editor.mode === 'edit' ? editingPrevious : null"
          :previous-label="prevLabel"
          :sorted-brackets="sortedBrackets"
          :readonly="isConfirmed"
          @saved="onSaved"
          @close="closeEditor"
          @dirty="(d) => (editorDirty = d)"
        />
      </aside>
    </div>
  </section>
</template>
