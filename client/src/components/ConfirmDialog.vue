<script setup>
// @ts-check
import { ref, watch, nextTick, computed } from 'vue';
import { dialogState, closeConfirm } from '../stores/dialog.js';

/** @type {import('vue').Ref<HTMLButtonElement | null>} */
const confirmBtn = ref(null);
/** @type {import('vue').Ref<HTMLInputElement | null>} */
const requireInput = ref(null);

/** 需輸入確認文字時，是否已輸入正確 */
const canConfirm = computed(
  () => dialogState.requireText === '' || dialogState.inputValue.trim() === dialogState.requireText,
);

watch(
  () => dialogState.open,
  async (open) => {
    if (open) {
      await nextTick();
      if (dialogState.requireText !== '') requireInput.value?.focus();
      else confirmBtn.value?.focus();
    }
  },
);

/**
 * @param {KeyboardEvent} e
 * @returns {void}
 */
function onKeydown(e) {
  if (e.key === 'Escape') closeConfirm(false);
}
</script>

<template>
  <div v-if="dialogState.open" class="modal-backdrop" @keydown="onKeydown">
    <form
      class="modal"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogState.title"
      @submit.prevent="closeConfirm(true)"
    >
      <h3 class="modal-title">{{ dialogState.title }}</h3>
      <p class="modal-message">{{ dialogState.message }}</p>
      <label v-if="dialogState.requireText !== ''" class="field">
        <span class="field-label">請輸入「{{ dialogState.requireText }}」以確認</span>
        <input ref="requireInput" v-model="dialogState.inputValue" class="input" autocomplete="off" />
      </label>
      <div class="modal-actions">
        <button type="button" class="btn" @click="closeConfirm(false)">{{ dialogState.cancelText }}</button>
        <button
          ref="confirmBtn"
          type="submit"
          class="btn"
          :class="dialogState.danger ? 'btn-danger' : 'btn-primary'"
          :disabled="!canConfirm"
        >
          {{ dialogState.confirmText }}
        </button>
      </div>
    </form>
  </div>
</template>
