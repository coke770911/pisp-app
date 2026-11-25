<script setup>
// @ts-check
import { toastState } from '../stores/dialog.js';
</script>

<template>
  <div class="toast-list" aria-live="polite">
    <div v-for="t in toastState.items" :key="t.id" class="toast" :class="`toast-${t.kind}`">{{ t.text }}</div>
  </div>
</template>
