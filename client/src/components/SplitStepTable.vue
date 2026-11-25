<script setup>
// @ts-check
import { computed } from 'vue';
import { SPLIT_FEE_KEYS, FEE_LABELS } from '@shared/splitCalc.js';
import { formatNumber, formatDiff } from '../utils/format.js';

/** @typedef {import('@shared/splitCalc.js').SplitResult} SplitResult */
/** @typedef {import('@shared/splitCalc.js').SplitStep} SplitStep */
/** @typedef {import('@shared/splitCalc.js').Fees} Fees */

const props = defineProps({
  /** 拆帳結果（computeSplit 的回傳值） */
  result: { type: /** @type {import('vue').PropType<SplitResult>} */ (Object), required: true },
  /** 勞退自提率（%）；提供時於「勞退自提」表頭加註，null = 不加註 */
  pensionRate: { type: /** @type {import('vue').PropType<number | null>} */ (Number), default: null },
});

/**
 * 表頭文字（勞退自提加註目前自提率；公健不計）。
 * @param {keyof Fees} k
 * @returns {string}
 */
function headLabel(k) {
  const label = FEE_LABELS[k];
  if (k !== 'pension_emp' || props.pensionRate === null) return label;
  return props.result.healthOnly ? `${label}（公健不計）` : `${label}（${props.pensionRate}%）`;
}

/**
 * @typedef {Object} StepRow
 * @property {SplitStep} step
 * @property {boolean} crossed 是否跨級距（與上一步級距不同）
 */

/** @type {import('vue').ComputedRef<StepRow[]>} */
const rows = computed(() =>
  props.result.steps.map((s, i) => ({
    step: s,
    crossed: i > 0 && s.salary_limit !== props.result.steps[i - 1].salary_limit,
  })),
);

/** 最終累計薪資 */
const finalSalary = computed(() => {
  const steps = props.result.steps;
  return steps.length > 0 ? steps[steps.length - 1].cumulative : 0;
});

/** 最終級距 */
const finalLimit = computed(() => {
  const steps = props.result.steps;
  return steps.length > 0 ? steps[steps.length - 1].salary_limit : 0;
});

/**
 * @param {number} n
 * @param {number} step
 * @returns {string}
 */
function diffClass(n, step) {
  if (n === 0) return 'zero';
  if (step === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}
</script>

<template>
  <div class="table-wrap">
    <table class="table table-compact step-table">
      <thead>
        <tr>
          <th>Step</th>
          <th>薪資來源</th>
          <th class="num">本筆金額</th>
          <th class="num">累計薪資</th>
          <th class="num">投保級距</th>
          <th v-for="k in SPLIT_FEE_KEYS" :key="k" class="num fee-col">{{ headLabel(k) }}</th>
          <th class="num">個人合計</th>
          <th class="num">學校合計</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.step.step"
          :class="{ 'row-base': r.step.step === 0, 'row-crossed': r.crossed }"
        >
          <td class="nowrap">
            <template v-if="r.step.step === 0">Step 0 <span class="tag tag-base">基準</span></template>
            <template v-else>
              Step {{ r.step.step }}
              <span v-if="r.crossed" class="tag tag-cross">跨級距</span>
            </template>
          </td>
          <td>{{ r.step.source_name || '（未命名）' }}</td>
          <td class="num">{{ formatNumber(r.step.amount) }}</td>
          <td class="num">{{ formatNumber(r.step.cumulative) }}</td>
          <td class="num strong">{{ result.bracketMissing ? '—' : formatNumber(r.step.salary_limit) }}</td>
          <td v-for="k in SPLIT_FEE_KEYS" :key="k" class="num" :class="diffClass(r.step.diff[k], r.step.step)">
            {{ r.step.step === 0 ? formatNumber(r.step.diff[k]) : formatDiff(r.step.diff[k]) }}
          </td>
          <td class="num strong" :class="diffClass(r.step.diff.emp_total, r.step.step)">
            {{ r.step.step === 0 ? formatNumber(r.step.diff.emp_total) : formatDiff(r.step.diff.emp_total) }}
          </td>
          <td class="num strong" :class="diffClass(r.step.diff.school_total, r.step.step)">
            {{ r.step.step === 0 ? formatNumber(r.step.diff.school_total) : formatDiff(r.step.diff.school_total) }}
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2">合計（最終保費）</td>
          <td class="num"></td>
          <td class="num">{{ formatNumber(finalSalary) }}</td>
          <td class="num">{{ result.bracketMissing ? '—' : formatNumber(finalLimit) }}</td>
          <td v-for="k in SPLIT_FEE_KEYS" :key="k" class="num">{{ formatNumber(result.total[k]) }}</td>
          <td class="num">{{ formatNumber(result.total.emp_total) }}</td>
          <td class="num">{{ formatNumber(result.total.school_total) }}</td>
        </tr>
      </tfoot>
    </table>
  </div>
</template>
