<script setup>
// @ts-check
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '../api/index.js';
import { ApiError, SERVICE_UNAVAILABLE_MESSAGE } from '../api/http.js';
import { setLoggedIn } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const showPassword = ref(false);
const loading = ref(false);
/** 錯誤訊息（空字串 = 無） */
const errorText = ref('');

/** @type {import('vue').Ref<HTMLInputElement | null>} */
const usernameInput = ref(null);
/** @type {import('vue').Ref<HTMLInputElement | null>} */
const passwordInput = ref(null);

/** 是否因登入逾時被導回 */
const expired = computed(() => route.query.expired === '1');

/**
 * 取得登入後要前往的站內路徑（只接受以單一 / 開頭的路徑，避免開放式導向）。
 * @returns {string}
 */
function redirectTarget() {
  const raw = route.query.redirect;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login')) {
    return value;
  }
  return '/payrolls';
}

/**
 * @param {import('vue').Ref<HTMLInputElement | null>} el
 * @returns {Promise<void>}
 */
async function focusField(el) {
  await nextTick();
  el.value?.focus();
}

/** @returns {Promise<void>} */
async function onSubmit() {
  if (loading.value) return;
  errorText.value = '';
  if (username.value.trim() === '') {
    errorText.value = '請輸入帳號';
    await focusField(usernameInput);
    return;
  }
  if (password.value === '') {
    errorText.value = '請輸入密碼';
    await focusField(passwordInput);
    return;
  }
  loading.value = true;
  /** 失敗後要聚焦的欄位（輸入框於 loading 期間為 disabled，需在解除後再聚焦） */
  let refocusPassword = false;
  try {
    const user = await login(username.value.trim(), password.value);
    setLoggedIn(user.username);
    password.value = '';
    await router.replace(redirectTarget());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      errorText.value = '帳號或密碼錯誤';
      password.value = '';
      refocusPassword = true;
    } else if (err instanceof ApiError && (err.status === 429 || err.status === 503)) {
      errorText.value = err.message;
    } else {
      errorText.value = SERVICE_UNAVAILABLE_MESSAGE;
    }
  } finally {
    loading.value = false;
  }
  if (refocusPassword) await focusField(passwordInput);
}

onMounted(() => {
  void focusField(usernameInput);
});
</script>

<template>
  <div class="login-page">
    <form class="login-card" novalidate @submit.prevent="onSubmit">
      <h1 class="login-title">系統登入</h1>
      <p class="login-sub">HISP - 人事勞健保加退拆帳系統</p>

      <div v-if="expired && !errorText" class="alert alert-warning">登入逾時，請重新登入</div>
      <div v-if="errorText" class="alert alert-error" role="alert">{{ errorText }}</div>

      <label class="field">
        <span class="field-label">帳號</span>
        <input
          ref="usernameInput"
          v-model="username"
          type="text"
          class="input"
          autocomplete="username"
          maxlength="100"
          :disabled="loading"
        />
      </label>

      <label class="field">
        <span class="field-label">密碼</span>
        <span class="input-with-btn">
          <input
            ref="passwordInput"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="input"
            autocomplete="current-password"
            maxlength="200"
            :disabled="loading"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :aria-pressed="showPassword"
            :aria-label="showPassword ? '隱藏密碼' : '顯示密碼'"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? '隱藏' : '顯示' }}
          </button>
        </span>
      </label>

      <button type="submit" class="btn btn-primary btn-block" :disabled="loading">
        {{ loading ? '登入中…' : '登入' }}
      </button>
    </form>
  </div>
</template>
