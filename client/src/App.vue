<script setup>
// @ts-check
import { ref, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { authState, clearAuth, isAdmin, currentDisplayName, roleLabel } from './stores/auth.js';
import { logout } from './api/index.js';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ToastList from './components/ToastList.vue';

const router = useRouter();
const route = useRoute();

/** 登出中（防重複點擊） */
const loggingOut = ref(false);

/** 是否顯示主導覽（登入頁不顯示） */
const showNav = computed(() => route.name !== 'login' && authState.user !== null);

/** 目前登入者角色名稱 */
const currentRoleLabel = computed(() => (authState.user ? roleLabel(authState.user.role) : ''));

/** @returns {Promise<void>} */
async function onLogout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await logout();
  } catch {
    // 登出失敗（例如 session 已過期）仍清除前端狀態
  } finally {
    clearAuth();
    loggingOut.value = false;
    await router.replace({ name: 'login' });
  }
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">HISP</span>
        <span class="brand-title">HISP - 人事勞健保加退拆帳系統</span>
      </div>
      <nav v-if="showNav" class="main-nav">
        <RouterLink to="/payrolls" class="nav-link">月度工作台</RouterLink>
        <RouterLink to="/brackets" class="nav-link">年度級距維護</RouterLink>
        <RouterLink v-if="isAdmin" to="/users" class="nav-link">帳號管理</RouterLink>
      </nav>
      <div v-if="showNav" class="user-area">
        <span class="user-name" :title="`目前登入者：${authState.user?.account ?? ''}`">{{ currentDisplayName }}</span>
        <span class="user-role">{{ currentRoleLabel }}</span>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="loggingOut" @click="onLogout">
          {{ loggingOut ? '登出中…' : '登出' }}
        </button>
      </div>
    </header>
    <main class="app-main">
      <RouterView />
    </main>
    <ConfirmDialog />
    <ToastList />
  </div>
</template>
