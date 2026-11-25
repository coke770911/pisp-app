<script setup>
// @ts-check
import { ref, computed, onMounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login, fetchCaptcha } from '../api/index.js';
import { ApiError, SERVICE_UNAVAILABLE_MESSAGE } from '../api/http.js';
import { setLoggedIn } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();

/** 驗證碼長度（4 位數字） */
const CAPTCHA_LENGTH = 4;

const account = ref('');
const password = ref('');
const captchaCode = ref('');
const showPassword = ref(false);
const loading = ref(false);
/** 錯誤訊息（空字串 = 無） */
const errorText = ref('');

/** 目前驗證碼 id（空字串 = 尚未取得） */
const captchaId = ref('');
/** 驗證碼圖片 data URL */
const captchaImage = ref('');
const captchaLoading = ref(false);
/** 驗證碼載入失敗訊息（空字串 = 無） */
const captchaError = ref('');
/** 驗證碼請求序號：只採用最後一次請求的結果 */
let captchaSeq = 0;

/** @type {import('vue').Ref<HTMLInputElement | null>} */
const accountInput = ref(null);
/** @type {import('vue').Ref<HTMLInputElement | null>} */
const passwordInput = ref(null);
/** @type {import('vue').Ref<HTMLInputElement | null>} */
const captchaInput = ref(null);

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

/**
 * 取得新驗證碼圖（舊的驗證碼即失效，並清空已輸入的驗證碼）。
 * @returns {Promise<void>}
 */
async function loadCaptcha() {
  const seq = ++captchaSeq;
  captchaLoading.value = true;
  captchaError.value = '';
  captchaCode.value = '';
  try {
    const c = await fetchCaptcha();
    if (seq !== captchaSeq) return;
    captchaId.value = c.captchaId;
    captchaImage.value = c.image;
  } catch (err) {
    if (seq !== captchaSeq) return;
    captchaId.value = '';
    captchaImage.value = '';
    // 429 顯示後端訊息；其他一律「服務暫時無法使用」，不顯示例外內容
    captchaError.value = err instanceof ApiError && err.status === 429 ? err.message : SERVICE_UNAVAILABLE_MESSAGE;
  } finally {
    if (seq === captchaSeq) captchaLoading.value = false;
  }
}

/** 「換一張」按鈕 */
function onRefreshCaptcha() {
  if (loading.value) return;
  void loadCaptcha().then(() => focusField(captchaInput));
}

/**
 * 驗證碼輸入只保留數字（最多 4 位）。
 * @param {Event} e
 * @returns {void}
 */
function onCaptchaInput(e) {
  const el = /** @type {HTMLInputElement} */ (e.target);
  const digits = el.value.replace(/\D/g, '').slice(0, CAPTCHA_LENGTH);
  if (el.value !== digits) el.value = digits;
  captchaCode.value = digits;
}

/** @typedef {'account' | 'password' | 'captcha' | null} FocusTarget */

/** @returns {Promise<void>} */
async function onSubmit() {
  // 送出中或驗證碼換圖中（舊驗證碼已失效）不送出
  if (loading.value || captchaLoading.value) return;
  errorText.value = '';
  if (account.value.trim() === '') {
    errorText.value = '請輸入帳號';
    await focusField(accountInput);
    return;
  }
  if (password.value === '') {
    errorText.value = '請輸入密碼';
    await focusField(passwordInput);
    return;
  }
  if (captchaId.value === '') {
    errorText.value = '驗證碼尚未載入，請按「換一張」';
    return;
  }
  if (!/^\d{4}$/.test(captchaCode.value)) {
    errorText.value = '請輸入 4 位數字驗證碼';
    await focusField(captchaInput);
    return;
  }
  loading.value = true;
  /** 失敗後要聚焦的欄位（輸入框於 loading 期間為 disabled，需在解除後再聚焦） @type {FocusTarget} */
  let refocus = null;
  let succeeded = false;
  try {
    const user = await login({
      account: account.value.trim(),
      password: password.value,
      captchaId: captchaId.value,
      captchaCode: captchaCode.value,
    });
    setLoggedIn(user);
    password.value = '';
    succeeded = true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && err.code === 'CAPTCHA_INVALID') {
      // 驗證碼錯誤：保留帳號密碼，只清驗證碼
      errorText.value = err.message;
      refocus = 'captcha';
    } else if (err instanceof ApiError && err.status === 401) {
      // 帳密錯誤或無權限：清空密碼與驗證碼
      errorText.value = err.message;
      password.value = '';
      refocus = 'password';
    } else if (err instanceof ApiError && (err.status === 429 || err.status === 503)) {
      errorText.value = err.message;
    } else {
      errorText.value = SERVICE_UNAVAILABLE_MESSAGE;
    }
  } finally {
    loading.value = false;
  }
  if (succeeded) {
    // 驗證碼為一次性，成功也換新圖（頁面隨即離開）
    void loadCaptcha();
    await router.replace(redirectTarget());
    return;
  }
  // 每次送出後都換新驗證碼圖（同時清空驗證碼欄）
  await loadCaptcha();
  if (refocus === 'password') await focusField(passwordInput);
  else await focusField(captchaInput);
}

onMounted(() => {
  void loadCaptcha();
  void focusField(accountInput);
});
</script>

<template>
  <div class="login-page">
    <form class="login-card" novalidate @submit.prevent="onSubmit">
      <h1 class="login-title">系統登入</h1>
      <p class="login-sub">HISP - 人事勞健保加退拆帳系統</p>
      <div class="alert alert-info">請使用校內帳號密碼登入</div>

      <div v-if="expired && !errorText" class="alert alert-warning">登入逾時，請重新登入</div>
      <div v-if="errorText" class="alert alert-error" role="alert">{{ errorText }}</div>

      <label class="field">
        <span class="field-label">帳號</span>
        <input
          ref="accountInput"
          v-model="account"
          type="text"
          class="input"
          autocomplete="username"
          maxlength="50"
          placeholder="校內帳號"
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

      <div class="field">
        <label class="field-label" for="login-captcha">驗證碼</label>
        <div class="captcha-row">
          <input
            id="login-captcha"
            ref="captchaInput"
            :value="captchaCode"
            type="text"
            class="input captcha-input"
            inputmode="numeric"
            maxlength="4"
            autocomplete="off"
            placeholder="4 位數字"
            :disabled="loading"
            @input="onCaptchaInput"
          />
          <span class="captcha-box">
            <img v-if="captchaImage" :src="captchaImage" class="captcha-img" alt="驗證碼圖片" />
            <span v-else class="captcha-placeholder muted">{{ captchaLoading ? '載入中…' : '無圖片' }}</span>
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="loading || captchaLoading"
            @click="onRefreshCaptcha"
          >
            換一張
          </button>
        </div>
        <span v-if="captchaError" class="field-hint captcha-error">{{ captchaError }}</span>
      </div>

      <button type="submit" class="btn btn-primary btn-block" :disabled="loading || captchaLoading">
        {{ loading ? '登入中…' : '登入' }}
      </button>
    </form>
  </div>
</template>
