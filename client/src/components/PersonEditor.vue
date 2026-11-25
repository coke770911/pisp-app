<script setup>
// @ts-check
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { computeSplit, normalizePensionRate, PENSION_RATE_MIN, PENSION_RATE_MAX } from '@shared/splitCalc.js';
import SplitStepTable from './SplitStepTable.vue';
import { updatePayroll, createPayroll } from '../api/index.js';
import { ApiError, errorMessage } from '../api/http.js';
import { normalizeIdNumber } from '../utils/compare.js';
import { formatNumber, toInt } from '../utils/format.js';
import { toast } from '../stores/dialog.js';

/** @typedef {import('../api/schemas.js').Payroll} Payroll */
/** @typedef {import('../api/schemas.js').InsuranceType} InsuranceType */
/** @typedef {import('../api/index.js').PayrollUpdateBody} PayrollUpdateBody */
/** @typedef {import('../api/index.js').PayrollCreateBody} PayrollCreateBody */
/** @typedef {import('@shared/splitCalc.js').Bracket} Bracket */

/**
 * 編輯中的薪資來源（金額以字串保存輸入原貌）
 * @typedef {Object} DraftItem
 * @property {number} key 前端列識別碼
 * @property {string} source_name
 * @property {string} amount
 */

/**
 * @typedef {Object} Draft
 * @property {string} employee_no
 * @property {string} name
 * @property {string} id_number
 * @property {string} birthday
 * @property {string} base_salary
 * @property {InsuranceType} insurance_type
 * @property {number} pension_rate 勞退自提率（%，0~6）
 * @property {DraftItem[]} items
 */

/** 勞退自提率選項：常用 0、1、3、6 排前面，其餘 0~6 整數依序列在後 */
const COMMON_PENSION_RATES = Object.freeze([0, 1, 3, 6]);
/** @type {ReadonlyArray<number>} */
const PENSION_RATE_OPTIONS = Object.freeze([
  ...COMMON_PENSION_RATES,
  ...Array.from({ length: PENSION_RATE_MAX - PENSION_RATE_MIN + 1 }, (_, i) => PENSION_RATE_MIN + i).filter(
    (r) => !COMMON_PENSION_RATES.includes(r),
  ),
]);

const props = defineProps({
  /** 編輯對象；null = 新增人員 */
  payroll: { type: /** @type {import('vue').PropType<Payroll | null>} */ (Object), default: null },
  /** 民國年（新增人員用） */
  year: { type: Number, required: true },
  /** 月份（新增人員用） */
  month: { type: Number, required: true },
  /** 上月同一人員資料（供對照）；null = 上月無此人 */
  previous: { type: /** @type {import('vue').PropType<Payroll | null>} */ (Object), default: null },
  /** 上月標籤，例如「115 年 8 月」 */
  previousLabel: { type: String, default: '上月' },
  /** 已依 salary_limit 遞增排序的級距 */
  sortedBrackets: { type: /** @type {import('vue').PropType<Bracket[]>} */ (Array), required: true },
  /** 已確認月份 → 唯讀 */
  readonly: { type: Boolean, default: false },
});

const emit = defineEmits({
  /** @param {Payroll} _p @param {boolean} _created */
  saved: (_p, _created) => true,
  close: () => true,
  /** @param {boolean} _d */
  dirty: (_d) => true,
});

let itemSeq = 0;

/** 是否為新增模式 */
const isNew = computed(() => props.payroll === null);

/**
 * @param {Payroll | null} p
 * @returns {Draft}
 */
function draftFromPayroll(p) {
  if (!p) {
    return {
      employee_no: '',
      name: '',
      id_number: '',
      birthday: '',
      base_salary: '0',
      insurance_type: '勞健',
      pension_rate: 0,
      items: [],
    };
  }
  return {
    employee_no: p.employee_no,
    name: p.name,
    id_number: p.id_number ?? '',
    birthday: p.birthday ?? '',
    base_salary: String(p.base_salary),
    insurance_type: p.insurance_type,
    pension_rate: normalizePensionRate(p.pension_rate),
    items: [...p.items]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((it) => ({ key: ++itemSeq, source_name: it.source_name, amount: String(it.amount) })),
  };
}

/** @type {import('vue').Ref<Draft>} */
const draft = ref(draftFromPayroll(props.payroll));
const saving = ref(false);
/** 最近一次儲存的衝突訊息（409，例：職員編號已被其他人員使用） */
const conflictMessage = ref('');
/** @type {import('vue').Ref<HTMLElement | null>} */
const itemsBody = ref(null);
/** @type {import('vue').Ref<HTMLInputElement | null>} */
const firstInput = ref(null);

/** 輸入控制項是否停用 */
const locked = computed(() => props.readonly || saving.value);

/**
 * 正規化草稿為 PUT 送出格式（不含身分證號：身分證號為識別鍵，不可修改）。
 * @param {Draft} d
 * @returns {PayrollUpdateBody}
 */
function normalize(d) {
  return {
    employee_no: d.employee_no.trim(),
    name: d.name.trim(),
    birthday: d.birthday.trim(),
    base_salary: toInt(d.base_salary) ?? 0,
    insurance_type: d.insurance_type,
    pension_rate: normalizePensionRate(d.pension_rate),
    items: d.items.map((it) => ({ source_name: it.source_name.trim(), amount: toInt(it.amount) ?? 0 })),
  };
}

/**
 * 草稿的比較用字串（保留輸入原貌，格式錯誤的輸入也視為變更）。
 * @param {Draft} d
 * @returns {string}
 */
function draftKey(d) {
  return JSON.stringify({
    e: d.employee_no.trim(),
    n: d.name.trim(),
    id: d.id_number.trim(),
    bd: d.birthday.trim(),
    b: d.base_salary.trim(),
    t: d.insurance_type,
    pr: d.pension_rate,
    i: d.items.map((it) => [it.source_name, it.amount.trim()]),
  });
}

/** 原始資料的比較用字串 */
const originalKey = computed(() => draftKey(draftFromPayroll(props.payroll)));

/** 是否有未儲存變更（新增模式：有任何輸入即視為變更） */
const isDirty = computed(() => draftKey(draft.value) !== originalKey.value);

watch(isDirty, (v) => emit('dirty', v), { immediate: true });

/** 欄位驗證錯誤 */
const validationErrors = computed(() => {
  const d = draft.value;
  /** @type {string[]} */
  const errs = [];
  if (isNew.value) {
    // 身分證號為識別鍵，僅新增時輸入
    const idNo = normalizeIdNumber(d.id_number);
    if (idNo === '') errs.push('請輸入身分證號');
    else if (idNo.length > 20) errs.push('身分證號不可超過 20 字');
  }
  const no = d.employee_no.trim();
  if (no === '') errs.push('請輸入職員編號');
  else if (no.length > 20) errs.push('職員編號不可超過 20 字');
  if (d.name.trim() === '') errs.push('請輸入姓名');
  else if (d.name.trim().length > 50) errs.push('姓名不可超過 50 字');
  if (d.birthday.trim().length > 20) errs.push('生日不可超過 20 字');
  const base = toInt(d.base_salary);
  if (base === null) errs.push('本薪必須為整數');
  else if (base < 0) errs.push('本薪不可為負數');
  d.items.forEach((it, i) => {
    const name = it.source_name.trim();
    if (name === '') errs.push(`第 ${i + 1} 筆薪資來源未填名稱`);
    else if (name.length > 50) errs.push(`第 ${i + 1} 筆薪資來源名稱超過 50 字`);
    if (toInt(it.amount) === null) errs.push(`第 ${i + 1} 筆金額必須為整數`);
  });
  return errs;
});

/**
 * @param {string} v
 * @returns {boolean}
 */
function invalidAmount(v) {
  return toInt(v) === null;
}

/** 即時拆帳結果（每次異動即以共用演算法重算） */
const split = computed(() => computeSplit(normalize(draft.value), props.sortedBrackets));

/** 最後一步（總薪資與最終級距） */
const lastStep = computed(() => {
  const s = split.value.steps;
  return s.length > 0 ? s[s.length - 1] : null;
});

/** 上月職員編號與本月（已存檔）不同時，回傳上月職員編號；否則 null */
const previousEmployeeNoChanged = computed(() => {
  const prev = props.previous;
  const cur = props.payroll;
  if (!prev || !cur) return null;
  return prev.employee_no.trim() !== cur.employee_no.trim() ? prev.employee_no : null;
});

/** 上月加項（依 sort_order） */
const previousItems = computed(() =>
  props.previous ? [...props.previous.items].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)) : [],
);

/** 上月加項合計 */
const previousTotal = computed(() =>
  props.previous ? props.previous.base_salary + previousItems.value.reduce((s, it) => s + it.amount, 0) : 0,
);

/** @returns {Promise<void>} */
async function addItem() {
  draft.value.items.push({ key: ++itemSeq, source_name: '', amount: '0' });
  await nextTick();
  const inputs = itemsBody.value?.querySelectorAll('input.item-name');
  const last = inputs && inputs.length > 0 ? /** @type {HTMLInputElement} */ (inputs[inputs.length - 1]) : null;
  last?.focus();
}

/**
 * @param {number} idx
 * @returns {void}
 */
function removeItem(idx) {
  draft.value.items.splice(idx, 1);
}

/**
 * @param {number} idx
 * @param {-1 | 1} dir
 * @returns {void}
 */
function moveItem(idx, dir) {
  const items = draft.value.items;
  const target = idx + dir;
  if (target < 0 || target >= items.length) return;
  const [it] = items.splice(idx, 1);
  items.splice(target, 0, it);
}

/** 以上月加項取代目前加項（僅填入草稿，仍需按儲存） */
function applyPreviousItems() {
  draft.value.items = previousItems.value.map((it) => ({
    key: ++itemSeq,
    source_name: it.source_name,
    amount: String(it.amount),
  }));
}

/** @returns {void} */
function resetDraft() {
  draft.value = draftFromPayroll(props.payroll);
}

/** @returns {Promise<void>} */
async function onSave() {
  if (saving.value) return;
  if (props.readonly) return;
  if (validationErrors.value.length > 0) {
    toast(validationErrors.value[0], 'warning');
    return;
  }
  saving.value = true;
  conflictMessage.value = '';
  try {
    const body = normalize(draft.value);
    const current = props.payroll;
    /** @type {Payroll} */
    let saved;
    if (current) {
      saved = await updatePayroll(current.id, body);
    } else {
      /** @type {PayrollCreateBody} */
      const createBody = { ...body, id_number: normalizeIdNumber(draft.value.id_number) };
      saved = await createPayroll(props.year, props.month, createBody);
    }
    // 先同步草稿再通知父層，避免父層判斷為未儲存
    draft.value = draftFromPayroll(saved);
    emit('saved', saved, current === null);
    toast(`${current ? '已儲存' : '已新增'} ${saved.employee_no} ${saved.name}`, 'success');
  } catch (err) {
    const msg = errorMessage(err);
    // 409：職員編號／身分證號重複或月份已確認，訊息保留於表單上方
    if (err instanceof ApiError && err.status === 409) conflictMessage.value = msg;
    toast(msg, 'error');
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  if (isNew.value) firstInput.value?.focus();
});

defineExpose({ isDirty });
</script>

<template>
  <form class="editor" @submit.prevent="onSave">
    <div class="editor-head">
      <h3 class="editor-title">
        <template v-if="isNew">新增人員（{{ year }} 年 {{ month }} 月）</template>
        <template v-else>{{ payroll?.employee_no }}　{{ payroll?.name }}</template>
        <span v-if="isDirty && !isNew" class="tag tag-dirty">未儲存</span>
        <span v-if="readonly" class="tag tag-confirmed">已確認（唯讀）</span>
      </h3>
      <button type="button" class="btn btn-ghost" aria-label="關閉" @click="emit('close')">關閉 ✕</button>
    </div>

    <div class="editor-grid editor-grid-basic">
      <label class="field">
        <span class="field-label">職員編號</span>
        <input
          ref="firstInput"
          v-model="draft.employee_no"
          class="input"
          :class="{ invalid: draft.employee_no.trim() === '' }"
          maxlength="20"
          autocomplete="off"
          :disabled="locked"
        />
      </label>
      <label class="field">
        <span class="field-label">姓名</span>
        <input v-model="draft.name" class="input" maxlength="50" :disabled="locked" />
      </label>
      <label class="field">
        <span class="field-label">身分證號{{ isNew ? '' : '（識別鍵，不可修改）' }}</span>
        <input
          v-model="draft.id_number"
          class="input mono"
          :class="{ invalid: isNew && draft.id_number.trim() === '' }"
          maxlength="20"
          autocomplete="off"
          :readonly="!isNew"
          :disabled="locked"
          @blur="isNew && (draft.id_number = normalizeIdNumber(draft.id_number))"
        />
      </label>
      <label class="field">
        <span class="field-label">生日（原樣保存，例 0750101）</span>
        <input v-model="draft.birthday" class="input" maxlength="20" autocomplete="off" :disabled="locked" />
      </label>
    </div>

    <div class="editor-grid editor-grid-pay">
      <label class="field">
        <span class="field-label">本薪</span>
        <input
          v-model="draft.base_salary"
          class="input num"
          :class="{ invalid: invalidAmount(draft.base_salary) }"
          inputmode="numeric"
          :disabled="locked"
        />
      </label>
      <div class="field">
        <span class="field-label">投保別</span>
        <div class="radio-group">
          <label class="radio">
            <input v-model="draft.insurance_type" type="radio" value="勞健" :disabled="locked" />
            勞健
          </label>
          <label class="radio">
            <input v-model="draft.insurance_type" type="radio" value="公健" :disabled="locked" />
            公健（只計健保）
          </label>
        </div>
      </div>
      <label class="field">
        <span class="field-label">勞退自提</span>
        <select v-model.number="draft.pension_rate" class="input input-select" :disabled="locked">
          <option v-for="r in PENSION_RATE_OPTIONS" :key="r" :value="r">{{ r }}%</option>
        </select>
        <span v-if="draft.insurance_type === '公健'" class="field-hint">公健無勞退，自提不計</span>
      </label>
      <div class="field summary-field">
        <span class="field-label">總薪資／最終級距</span>
        <span class="summary-value">
          {{ formatNumber(lastStep ? lastStep.cumulative : 0) }}
          <span class="muted">／</span>
          {{ split.bracketMissing || !lastStep ? '—' : formatNumber(lastStep.salary_limit) }}
        </span>
      </div>
    </div>

    <div v-if="!isNew" class="prev-box">
      <div class="prev-head">
        <strong>{{ previousLabel }}資料對照</strong>
        <button
          v-if="previous && previousItems.length > 0"
          type="button"
          class="btn btn-sm"
          :disabled="locked"
          @click="applyPreviousItems"
        >
          套用上月加項
        </button>
      </div>
      <div v-if="!previous" class="muted">上月無此人員（新進）</div>
      <div v-else class="prev-body">
        <span v-if="previousEmployeeNoChanged !== null">
          上月職員編號：<strong class="mono">{{ previousEmployeeNoChanged }}</strong>
        </span>
        <span>
          投保別 <strong>{{ previous.insurance_type }}</strong>
        </span>
        <span>
          勞退自提
          <strong :class="{ 'rate-zero': normalizePensionRate(previous.pension_rate) === 0 }">
            {{ normalizePensionRate(previous.pension_rate) }}%
          </strong>
        </span>
        <span>
          本薪 <strong class="num">{{ formatNumber(previous.base_salary) }}</strong>
        </span>
        <span v-if="previousItems.length === 0" class="muted">無加項</span>
        <span v-for="it in previousItems" :key="`${it.sort_order}-${it.source_name}`" class="prev-item">
          {{ it.source_name }} <strong class="num">{{ formatNumber(it.amount) }}</strong>
        </span>
        <span>
          總薪資 <strong class="num">{{ formatNumber(previousTotal) }}</strong>
        </span>
      </div>
    </div>

    <div class="section-head">
      <h4>其他薪資來源（依序疊加）</h4>
      <button type="button" class="btn btn-sm" :disabled="locked" @click="addItem">＋ 新增薪資來源</button>
    </div>
    <table class="table table-compact items-table">
      <thead>
        <tr>
          <th class="num" style="width: 48px">順序</th>
          <th>來源名稱</th>
          <th class="num" style="width: 160px">金額</th>
          <th style="width: 170px">操作</th>
        </tr>
      </thead>
      <tbody ref="itemsBody">
        <tr v-if="draft.items.length === 0">
          <td colspan="4" class="empty-row">無其他薪資來源（僅本薪）</td>
        </tr>
        <tr v-for="(it, idx) in draft.items" :key="it.key">
          <td class="num muted">{{ idx + 1 }}</td>
          <td>
            <input
              v-model="it.source_name"
              class="input input-sm item-name"
              :class="{ invalid: it.source_name.trim() === '' }"
              maxlength="50"
              placeholder="例：助理加給"
              :disabled="locked"
            />
          </td>
          <td>
            <input
              v-model="it.amount"
              class="input input-sm num"
              :class="{ invalid: invalidAmount(it.amount) }"
              inputmode="numeric"
              :disabled="locked"
            />
          </td>
          <td class="nowrap">
            <button type="button" class="btn btn-icon" title="上移" :disabled="locked || idx === 0" @click="moveItem(idx, -1)">
              ▲
            </button>
            <button
              type="button"
              class="btn btn-icon"
              title="下移"
              :disabled="locked || idx === draft.items.length - 1"
              @click="moveItem(idx, 1)"
            >
              ▼
            </button>
            <button type="button" class="btn btn-icon btn-icon-danger" title="刪除" :disabled="locked" @click="removeItem(idx)">
              刪除
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="conflictMessage" class="alert alert-error">{{ conflictMessage }}</div>

    <div v-if="validationErrors.length > 0 && !readonly && isDirty" class="alert alert-warning">
      <div v-for="e in validationErrors" :key="e">{{ e }}</div>
    </div>

    <div class="section-head">
      <h4>階梯拆帳明細</h4>
      <span v-if="split.bracketMissing" class="tag tag-warn">該年度無級距資料，無法計算</span>
      <span v-else-if="split.healthOnly" class="tag tag-public">公健：只計健保（勞保、勞退為 0）</span>
    </div>
    <SplitStepTable :result="split" :pension-rate="normalizePensionRate(draft.pension_rate)" />

    <div class="editor-actions">
      <button type="button" class="btn" :disabled="locked || !isDirty" @click="resetDraft">還原變更</button>
      <button type="submit" class="btn btn-primary" :disabled="locked || !isDirty">
        {{ saving ? '儲存中…' : isNew ? '新增人員' : '儲存' }}
      </button>
    </div>
  </form>
</template>
