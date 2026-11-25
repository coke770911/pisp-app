<script setup>
// @ts-check
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { currentRocYear, FEE_KEYS, FEE_LABELS } from '@shared/splitCalc.js';
import {
  fetchBrackets,
  fetchBracketYears,
  importBrackets,
  deleteBracketYear,
  createBracket,
  updateBracket,
  deleteBracket,
  copyBrackets,
  downloadBracketExport,
} from '../api/index.js';
import { errorMessage } from '../api/http.js';
import { formatNumber, toInt } from '../utils/format.js';
import { askConfirm, toast } from '../stores/dialog.js';
import { authState } from '../stores/auth.js';

/** @typedef {import('../api/schemas.js').BracketRow} BracketRow */
/** @typedef {import('../api/index.js').BracketFields} BracketFields */
/** @typedef {keyof BracketFields} FieldKey */

/** 7 個可編輯欄位（順序同 Excel） */
/** @type {ReadonlyArray<FieldKey>} */
const FIELD_KEYS = Object.freeze(['salary_limit', ...FEE_KEYS]);

/** @type {Readonly<Record<FieldKey, string>>} */
const FIELD_LABELS = Object.freeze({ salary_limit: '月投保金額', ...pickFeeLabels() });

/** @returns {Record<Exclude<FieldKey, 'salary_limit'>, string>} */
function pickFeeLabels() {
  return {
    labor_emp: FEE_LABELS.labor_emp,
    labor_school: FEE_LABELS.labor_school,
    labor_occupational: FEE_LABELS.labor_occupational,
    pension_school: FEE_LABELS.pension_school,
    health_emp: FEE_LABELS.health_emp,
    health_school: FEE_LABELS.health_school,
  };
}

/**
 * 正在編輯的列（id = null 表示新增列）
 * @typedef {Object} EditingRow
 * @property {number | null} id
 * @property {Record<FieldKey, string>} values
 * @property {string} originalKey 開始編輯時的值（判斷是否有變更）
 */

const thisYear = currentRocYear();

/** 目前顯示的年度 */
const year = ref(thisYear);
/** 手動輸入的年度 */
const yearInput = ref('');
/** @type {import('vue').Ref<BracketRow[]>} */
const brackets = ref([]);
/** @type {import('vue').Ref<number[]>} */
const years = ref([]);
const loading = ref(false);
const loadError = ref('');

const uploading = ref(false);
const deletingYear = ref(false);
const copying = ref(false);
const exporting = ref(false);
const rowSaving = ref(false);
/** @type {import('vue').Ref<number | null>} 刪除中的列 id */
const rowDeletingId = ref(null);

/** @type {import('vue').Ref<EditingRow | null>} */
const editing = ref(null);

/** @type {import('vue').Ref<HTMLInputElement | null>} */
const fileInput = ref(null);
/** @type {import('vue').Ref<HTMLElement | null>} */
const tableEl = ref(null);

/** 任何寫入操作進行中 */
const busy = computed(
  () => uploading.value || deletingYear.value || copying.value || rowSaving.value || rowDeletingId.value !== null,
);

/** 下拉選單的年度選項（既有年度 + 目前年度） */
const yearOptions = computed(() => {
  const set = new Set(years.value);
  set.add(year.value);
  return [...set].sort((a, b) => b - a);
});

/** 正在編輯且有變更 */
const editingDirty = computed(() => {
  const e = editing.value;
  if (!e) return false;
  return e.id === null || JSON.stringify(e.values) !== e.originalKey;
});

/** 編輯列的驗證錯誤 */
const editErrors = computed(() => {
  const e = editing.value;
  /** @type {string[]} */
  const errs = [];
  if (!e) return errs;
  for (const k of FIELD_KEYS) {
    const v = toInt(e.values[k]);
    if (v === null) errs.push(`${FIELD_LABELS[k]} 必須為整數`);
    else if (v < 0) errs.push(`${FIELD_LABELS[k]} 不可為負數`);
  }
  const limit = toInt(e.values.salary_limit);
  if (limit !== null && limit <= 0) errs.push('月投保金額必須大於 0');
  return errs;
});

/**
 * @param {string} v
 * @returns {boolean}
 */
function invalidField(v) {
  const n = toInt(v);
  return n === null || n < 0;
}

/* ---------- 載入 ---------- */

/** @returns {Promise<void>} */
async function loadYears() {
  try {
    years.value = await fetchBracketYears();
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

/**
 * @param {number} y
 * @returns {Promise<void>}
 */
async function loadBrackets(y) {
  loading.value = true;
  loadError.value = '';
  try {
    const rows = await fetchBrackets(y);
    if (year.value !== y) return; // 已切換到其他年度，忽略舊回應
    brackets.value = [...rows].sort((a, b) => a.salary_limit - b.salary_limit);
  } catch (err) {
    if (year.value !== y) return;
    loadError.value = errorMessage(err);
    brackets.value = [];
  } finally {
    if (year.value === y) loading.value = false;
  }
}

/**
 * 有未儲存的列編輯時詢問是否放棄。
 * @returns {Promise<boolean>} true = 可繼續
 */
async function confirmDiscardEditing() {
  if (!editingDirty.value) return true;
  return askConfirm({
    title: '尚未儲存',
    message: '目前有正在編輯且尚未儲存的級距列，確定要放棄變更？',
    confirmText: '放棄變更',
    danger: true,
  });
}

/**
 * 切換年度。
 * @param {number} y
 * @returns {Promise<void>}
 */
async function switchYear(y) {
  if (y === year.value && !loadError.value) return;
  if (!(await confirmDiscardEditing())) return;
  editing.value = null;
  year.value = y;
  brackets.value = [];
  await loadBrackets(y);
}

/**
 * @param {Event} e
 * @returns {Promise<void>}
 */
async function onSelectYear(e) {
  const sel = /** @type {HTMLSelectElement} */ (e.target);
  const y = toInt(sel.value);
  // 先還原選單顯示，確認後再由 year 驅動
  sel.value = String(year.value);
  if (y !== null) await switchYear(y);
}

/** @returns {Promise<void>} */
async function onManualYear() {
  const y = toInt(yearInput.value);
  if (y === null || y < 1 || y > 999) {
    toast('請輸入有效的民國年（例：115）', 'warning');
    return;
  }
  await switchYear(y);
  yearInput.value = '';
}

/** 重新整理年度清單與目前年度資料 */
async function reloadAll() {
  await Promise.all([loadYears(), loadBrackets(year.value)]);
}

/* ---------- 整年度操作 ---------- */

/** @returns {void} */
function pickFile() {
  if (busy.value) return;
  fileInput.value?.click();
}

/**
 * 選檔後直接匯入目前年度。
 * @param {Event} e
 * @returns {Promise<void>}
 */
async function onFileChange(e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const file = input.files && input.files.length > 0 ? input.files[0] : null;
  input.value = '';
  if (!file || uploading.value) return;
  if (!(await confirmDiscardEditing())) return;
  const y = year.value;
  const count = brackets.value.length;
  const ok = await askConfirm({
    title: '匯入級距表',
    message:
      count > 0
        ? `${y} 年度已有 ${count} 筆級距，匯入「${file.name}」將覆蓋 ${count} 筆，確定繼續？`
        : `確定將「${file.name}」匯入為 ${y} 年度級距？`,
    confirmText: count > 0 ? '覆蓋匯入' : '匯入',
    danger: count > 0,
  });
  if (!ok) return;
  uploading.value = true;
  try {
    editing.value = null;
    const result = await importBrackets(y, file);
    toast(`已匯入 ${result.year} 年度級距 ${formatNumber(result.count)} 筆`, 'success');
    await reloadAll();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    uploading.value = false;
  }
}

/** @returns {Promise<void>} */
async function onDeleteYear() {
  if (deletingYear.value) return;
  const y = year.value;
  const count = brackets.value.length;
  if (count === 0) return;
  const ok = await askConfirm({
    title: '刪除本年度級距',
    message: `將刪除 ${y} 年度全部 ${count} 筆級距，刪除後無法復原（可先「匯出本年度 xlsx」備份）。`,
    confirmText: '刪除',
    danger: true,
    requireText: String(y),
  });
  if (!ok) return;
  deletingYear.value = true;
  try {
    editing.value = null;
    const result = await deleteBracketYear(y);
    toast(`已刪除 ${result.year} 年度級距 ${formatNumber(result.deleted)} 筆`, 'success');
    await reloadAll();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    deletingYear.value = false;
  }
}

/** @returns {Promise<void>} */
async function onCopyNextYear() {
  if (copying.value) return;
  const from = year.value;
  const to = from + 1;
  if (!(await confirmDiscardEditing())) return;
  const ok = await askConfirm({
    title: '複製到下年度',
    message: `將 ${from} 年度 ${brackets.value.length} 筆級距複製為 ${to} 年度，確定繼續？`,
    confirmText: '複製',
  });
  if (!ok) return;
  copying.value = true;
  try {
    editing.value = null;
    const result = await copyBrackets(from, to);
    toast(`已複製 ${formatNumber(result.count)} 筆級距到 ${result.year} 年度`, 'success');
    await loadYears();
  } catch (err) {
    const msg = errorMessage(err);
    toast(msg, 'error');
  } finally {
    copying.value = false;
  }
}

/** @returns {Promise<void>} */
async function onExport() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const name = await downloadBracketExport(year.value);
    toast(`已下載 ${name}`, 'success');
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    exporting.value = false;
  }
}

/* ---------- 單列編輯 ---------- */

/**
 * @param {BracketRow | null} row null = 新增列
 * @returns {Record<FieldKey, string>}
 */
function valuesFrom(row) {
  /** @type {Record<FieldKey, string>} */
  const v = {
    salary_limit: '',
    labor_emp: '0',
    labor_school: '0',
    labor_occupational: '0',
    pension_school: '0',
    health_emp: '0',
    health_school: '0',
  };
  if (row) for (const k of FIELD_KEYS) v[k] = String(row[k]);
  return v;
}

/**
 * @param {BracketRow | null} row
 * @returns {Promise<void>}
 */
async function startEdit(row) {
  if (busy.value) return;
  if (editing.value && !(await confirmDiscardEditing())) return;
  const values = valuesFrom(row);
  editing.value = { id: row ? (row.id ?? null) : null, values, originalKey: JSON.stringify(values) };
  await nextTick();
  const first = /** @type {HTMLInputElement | null} */ (tableEl.value?.querySelector('input.row-input') ?? null);
  first?.focus();
  first?.select();
}

/** @returns {void} */
function cancelEdit() {
  editing.value = null;
}

/** @returns {Promise<void>} */
async function saveRow() {
  if (rowSaving.value) return;
  const e = editing.value;
  if (!e) return;
  if (editErrors.value.length > 0) {
    toast(editErrors.value[0], 'warning');
    return;
  }
  /** @type {BracketFields} */
  const fields = {
    salary_limit: toInt(e.values.salary_limit) ?? 0,
    labor_emp: toInt(e.values.labor_emp) ?? 0,
    labor_school: toInt(e.values.labor_school) ?? 0,
    labor_occupational: toInt(e.values.labor_occupational) ?? 0,
    pension_school: toInt(e.values.pension_school) ?? 0,
    health_emp: toInt(e.values.health_emp) ?? 0,
    health_school: toInt(e.values.health_school) ?? 0,
  };
  rowSaving.value = true;
  try {
    if (e.id === null) {
      const created = await createBracket(year.value, fields);
      brackets.value = [...brackets.value, created];
      toast(`已新增月投保金額 ${formatNumber(created.salary_limit)}`, 'success');
      if (!years.value.includes(year.value)) await loadYears();
    } else {
      const id = e.id;
      const updated = await updateBracket(id, fields);
      brackets.value = brackets.value.map((b) => (b.id === id ? updated : b));
      toast(`已更新月投保金額 ${formatNumber(updated.salary_limit)}`, 'success');
    }
    // 依月投保金額重新排序
    brackets.value = [...brackets.value].sort((a, b) => a.salary_limit - b.salary_limit);
    editing.value = null;
  } catch (err) {
    // 409（重複月投保金額）等顯示後端訊息，保留編輯內容
    toast(errorMessage(err), 'error');
  } finally {
    rowSaving.value = false;
  }
}

/**
 * @param {BracketRow} row
 * @returns {Promise<void>}
 */
async function removeRow(row) {
  if (rowDeletingId.value !== null || row.id === undefined) return;
  const id = row.id;
  const ok = await askConfirm({
    title: '刪除級距',
    message: `確定刪除 ${year.value} 年度月投保金額 ${formatNumber(row.salary_limit)} 這一列？`,
    confirmText: '刪除',
    danger: true,
  });
  if (!ok) return;
  rowDeletingId.value = id;
  try {
    await deleteBracket(id);
    brackets.value = brackets.value.filter((b) => b.id !== id);
    toast(`已刪除月投保金額 ${formatNumber(row.salary_limit)}`, 'success');
    if (brackets.value.length === 0) await loadYears();
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    rowDeletingId.value = null;
  }
}

/* ---------- 離開提示 ---------- */

/**
 * @param {BeforeUnloadEvent} e
 * @returns {void}
 */
function onBeforeUnload(e) {
  if (editingDirty.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}

onBeforeRouteLeave(async () => {
  // 登入逾時導向時不提示
  if (authState.username === null) return true;
  return confirmDiscardEditing();
});

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload);
  void loadYears();
  void loadBrackets(year.value);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h2 class="page-title">年度級距維護</h2>
      <span class="muted">目前年度：民國 {{ year }} 年</span>
    </div>

    <div class="toolbar card">
      <div class="toolbar-group">
        <label class="inline-field">
          <span>年度</span>
          <select class="input input-select" :value="year" :disabled="loading && brackets.length === 0 && busy" @change="onSelectYear">
            <option v-for="y in yearOptions" :key="y" :value="y">
              {{ y }} 年{{ years.includes(y) ? '' : '（無資料）' }}
            </option>
          </select>
        </label>
        <button type="button" class="btn btn-sm" :class="{ 'btn-active': year === thisYear }" @click="switchYear(thisYear)">
          本年度（{{ thisYear }}）
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="{ 'btn-active': year === thisYear + 1 }"
          @click="switchYear(thisYear + 1)"
        >
          下年度（{{ thisYear + 1 }}）
        </button>
        <form class="inline-form" @submit.prevent="onManualYear">
          <input v-model="yearInput" class="input input-year" inputmode="numeric" maxlength="3" placeholder="年度" />
          <button type="submit" class="btn btn-sm">切換</button>
        </form>
      </div>

      <div class="toolbar-group">
        <input
          ref="fileInput"
          type="file"
          class="hidden-file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          @change="onFileChange"
        />
        <button type="button" class="btn btn-primary" :disabled="busy || loading" @click="pickFile">
          {{ uploading ? '匯入中…' : `上傳 xlsx 到 ${year} 年度` }}
        </button>
        <button type="button" class="btn" :disabled="exporting || brackets.length === 0" @click="onExport">
          {{ exporting ? '下載中…' : '匯出本年度 xlsx' }}
        </button>
        <button type="button" class="btn" :disabled="busy || brackets.length === 0" @click="onCopyNextYear">
          {{ copying ? '複製中…' : `複製到下年度（${year + 1}）` }}
        </button>
        <button type="button" class="btn btn-danger-outline" :disabled="busy || brackets.length === 0" @click="onDeleteYear">
          {{ deletingYear ? '刪除中…' : '刪除本年度級距' }}
        </button>
      </div>
    </div>

    <p class="hint">
      Excel 格式（表頭在第 1 列，共 7 欄）：月投保金額、勞保費個人、勞保費學校(不含職災)、勞保費學校-職災、勞退金-學校、健保費-個人、健保費-學校。上傳會整年度覆蓋目前選擇的年度；也可先「匯出本年度 xlsx」修改後再上傳。
    </p>

    <div class="card">
      <div class="card-head">
        <h3>{{ year }} 年度級距（{{ brackets.length }} 筆）</h3>
        <button type="button" class="btn btn-sm" :disabled="busy || loading || editing !== null" @click="startEdit(null)">
          ＋ 新增一列
        </button>
      </div>
      <div v-if="loadError" class="alert alert-error">{{ loadError }}</div>

      <!-- 列編輯表單：輸入框以 form 屬性連結，Enter 即可儲存 -->
      <form id="bracket-row-form" class="hidden-form" @submit.prevent="saveRow"></form>

      <div v-if="editing && editErrors.length > 0" class="alert alert-warning">
        <div v-for="msg in editErrors" :key="msg">{{ msg }}</div>
      </div>

      <div v-if="!loadError" ref="tableEl" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="num" style="width: 48px">#</th>
              <th v-for="k in FIELD_KEYS" :key="k" class="num">{{ FIELD_LABELS[k] }}</th>
              <th style="width: 150px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="editing && editing.id === null" class="row-editing">
              <td class="num muted">新</td>
              <td v-for="k in FIELD_KEYS" :key="k" class="num">
                <input
                  v-model="editing.values[k]"
                  form="bracket-row-form"
                  class="input input-sm num row-input"
                  :class="{ invalid: invalidField(editing.values[k]) }"
                  inputmode="numeric"
                  :aria-label="FIELD_LABELS[k]"
                  :disabled="rowSaving"
                />
              </td>
              <td class="nowrap">
                <button type="submit" form="bracket-row-form" class="btn btn-sm btn-primary" :disabled="rowSaving">
                  {{ rowSaving ? '儲存中…' : '儲存' }}
                </button>
                <button type="button" class="btn btn-sm" :disabled="rowSaving" @click="cancelEdit">取消</button>
              </td>
            </tr>
            <tr v-if="!loading && brackets.length === 0 && !(editing && editing.id === null)">
              <td :colspan="FIELD_KEYS.length + 2" class="empty-row">
                此年度尚無級距資料：可上傳 xlsx、從上一年度「複製到下年度」，或「新增一列」。
              </td>
            </tr>
            <template v-for="(b, i) in brackets" :key="b.id ?? b.salary_limit">
              <tr v-if="editing && editing.id !== null && editing.id === b.id" class="row-editing">
                <td class="num muted">{{ i + 1 }}</td>
                <td v-for="k in FIELD_KEYS" :key="k" class="num">
                  <input
                    v-model="editing.values[k]"
                    form="bracket-row-form"
                    class="input input-sm num row-input"
                    :class="{ invalid: invalidField(editing.values[k]) }"
                    inputmode="numeric"
                    :aria-label="FIELD_LABELS[k]"
                    :disabled="rowSaving"
                  />
                </td>
                <td class="nowrap">
                  <button type="submit" form="bracket-row-form" class="btn btn-sm btn-primary" :disabled="rowSaving">
                    {{ rowSaving ? '儲存中…' : '儲存' }}
                  </button>
                  <button type="button" class="btn btn-sm" :disabled="rowSaving" @click="cancelEdit">取消</button>
                </td>
              </tr>
              <tr v-else>
                <td class="num muted">{{ i + 1 }}</td>
                <td class="num strong">{{ formatNumber(b.salary_limit) }}</td>
                <td v-for="k in FEE_KEYS" :key="k" class="num">{{ formatNumber(b[k]) }}</td>
                <td class="nowrap">
                  <button
                    type="button"
                    class="btn btn-sm"
                    :disabled="busy || editing !== null || b.id === undefined"
                    @click="startEdit(b)"
                  >
                    編輯
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-danger-outline"
                    :disabled="busy || editing !== null || b.id === undefined"
                    @click="removeRow(b)"
                  >
                    {{ rowDeletingId === b.id ? '刪除中…' : '刪除' }}
                  </button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-if="loading" class="muted loading-line">載入中…</div>
    </div>
  </section>
</template>
