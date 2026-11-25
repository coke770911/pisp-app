<script setup>
// @ts-check
import { ref, computed, onMounted, nextTick } from 'vue';
import { fetchUsers, createUser, updateUser, deleteUser } from '../api/index.js';
import { errorMessage } from '../api/http.js';
import { askConfirm, toast } from '../stores/dialog.js';
import { authState, roleLabel, ROLE_LABELS } from '../stores/auth.js';
import { formatRocDateTime } from '../utils/format.js';

/** @typedef {import('../api/schemas.js').SystemUser} SystemUser */
/** @typedef {import('../api/schemas.js').Role} Role */

/** 帳號格式：英數與 `._-`，1~50 字 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{1,50}$/;

/** 角色選項 */
const ROLE_OPTIONS = /** @type {{ value: Role, label: string }[]} */ ([
  { value: 'user', label: ROLE_LABELS.user },
  { value: 'admin', label: ROLE_LABELS.admin },
]);

/** @type {import('vue').Ref<SystemUser[]>} */
const users = ref([]);
const loading = ref(false);
/** 載入失敗訊息（空字串 = 無） */
const loadError = ref('');

/* ---------- 新增表單 ---------- */
const newAccount = ref('');
/** @type {import('vue').Ref<Role>} */
const newRole = ref('user');
const creating = ref(false);
/** 新增表單驗證訊息（空字串 = 無） */
const createError = ref('');
/** @type {import('vue').Ref<HTMLInputElement | null>} */
const accountInput = ref(null);

/** 正在寫入（切換角色／啟停用／刪除）的帳號 id；null = 無 */
/** @type {import('vue').Ref<number | null>} */
const pendingId = ref(null);

/** 是否有任何寫入中的操作（期間停用所有寫入按鈕，防重複送出） */
const writing = computed(() => creating.value || pendingId.value !== null);

/**
 * 是否為目前登入者本人（帳號不分大小寫比對）。
 * @param {SystemUser} u
 * @returns {boolean}
 */
function isSelf(u) {
  const me = authState.user;
  return me !== null && me.account.toLowerCase() === u.account.toLowerCase();
}

/**
 * 依帳號排序。
 * @param {SystemUser[]} list
 * @returns {SystemUser[]}
 */
function sortByAccount(list) {
  return [...list].sort((a, b) => a.account.localeCompare(b.account));
}

/**
 * 以更新後的帳號取代列表中的同 id 資料。
 * @param {SystemUser} updated
 * @returns {void}
 */
function replaceUser(updated) {
  users.value = users.value.map((u) => (u.id === updated.id ? updated : u));
}

/** @returns {Promise<void>} */
async function loadUsers() {
  loading.value = true;
  loadError.value = '';
  try {
    users.value = sortByAccount(await fetchUsers());
  } catch (err) {
    loadError.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/** @returns {Promise<void>} */
async function onCreate() {
  if (creating.value) return;
  createError.value = '';
  const account = newAccount.value.trim();
  if (!ACCOUNT_PATTERN.test(account)) {
    createError.value = '帳號需為 1~50 字，只能包含英文字母、數字與 . _ -';
    await nextTick();
    accountInput.value?.focus();
    return;
  }
  creating.value = true;
  try {
    const created = await createUser(account, newRole.value);
    users.value = sortByAccount([...users.value.filter((u) => u.id !== created.id), created]);
    newAccount.value = '';
    newRole.value = 'user';
    toast(`已新增帳號 ${created.account}（${roleLabel(created.role)}）`, 'success');
  } catch (err) {
    // 409「帳號已存在」、403「權限不足」等直接顯示後端訊息
    createError.value = errorMessage(err);
  } finally {
    creating.value = false;
  }
}

/**
 * 切換角色（管理者 ⇄ 一般使用者）。
 * @param {SystemUser} u
 * @returns {Promise<void>}
 */
async function onToggleRole(u) {
  if (writing.value || isSelf(u)) return;
  /** @type {Role} */
  const role = u.role === 'admin' ? 'user' : 'admin';
  const ok = await askConfirm({
    title: '變更角色',
    message: `確定將帳號「${u.account}」的角色改為「${roleLabel(role)}」？`,
    confirmText: '變更',
  });
  if (!ok || writing.value) return;
  pendingId.value = u.id;
  try {
    const updated = await updateUser(u.id, { role });
    replaceUser(updated);
    toast(`已將 ${updated.account} 改為${roleLabel(updated.role)}`, 'success');
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    pendingId.value = null;
  }
}

/**
 * 啟用／停用帳號。
 * @param {SystemUser} u
 * @returns {Promise<void>}
 */
async function onToggleActive(u) {
  if (writing.value || isSelf(u)) return;
  const nextActive = !u.is_active;
  if (!nextActive) {
    const ok = await askConfirm({
      title: '停用帳號',
      message: `確定停用帳號「${u.account}」？停用後該帳號將無法登入，已登入的連線也會被登出。`,
      confirmText: '停用',
      danger: true,
    });
    if (!ok || writing.value) return;
  }
  pendingId.value = u.id;
  try {
    const updated = await updateUser(u.id, { is_active: nextActive });
    replaceUser(updated);
    toast(`已${updated.is_active ? '啟用' : '停用'}帳號 ${updated.account}`, 'success');
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    pendingId.value = null;
  }
}

/**
 * 刪除帳號（確認後）。
 * @param {SystemUser} u
 * @returns {Promise<void>}
 */
async function onDelete(u) {
  if (writing.value || isSelf(u)) return;
  const ok = await askConfirm({
    title: '刪除帳號',
    message: `確定刪除帳號「${u.account}」？刪除後該帳號將無法登入本系統，此動作無法復原。`,
    confirmText: '刪除',
    danger: true,
  });
  if (!ok || writing.value) return;
  pendingId.value = u.id;
  try {
    await deleteUser(u.id);
    users.value = users.value.filter((x) => x.id !== u.id);
    toast(`已刪除帳號 ${u.account}`, 'success');
  } catch (err) {
    toast(errorMessage(err), 'error');
  } finally {
    pendingId.value = null;
  }
}

onMounted(() => {
  void loadUsers();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h2 class="page-title">帳號管理</h2>
      <span class="muted">共 {{ users.length }} 個帳號</span>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>新增帳號</h3>
      </div>
      <form class="inline-form users-create-form" novalidate @submit.prevent="onCreate">
        <label class="inline-field">
          <span>帳號</span>
          <input
            ref="accountInput"
            v-model="newAccount"
            type="text"
            class="input"
            maxlength="50"
            autocomplete="off"
            placeholder="校內帳號"
            :disabled="creating"
          />
        </label>
        <label class="inline-field">
          <span>角色</span>
          <select v-model="newRole" class="input input-select" :disabled="creating">
            <option v-for="opt in ROLE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>
        <button type="submit" class="btn btn-primary" :disabled="writing">
          {{ creating ? '新增中…' : '新增' }}
        </button>
      </form>
      <div v-if="createError" class="alert alert-error users-create-error" role="alert">{{ createError }}</div>
      <p class="hint">帳號需與校內帳號相同；新增後該帳號才能登入本系統。</p>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>系統帳號</h3>
        <button type="button" class="btn btn-sm" :disabled="loading" @click="loadUsers">重新整理</button>
      </div>
      <div v-if="loadError" class="alert alert-error">{{ loadError }}</div>

      <div v-if="!loadError" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>帳號</th>
              <th>顯示名稱</th>
              <th>角色</th>
              <th>狀態</th>
              <th>建立者</th>
              <th>最後登入時間</th>
              <th style="width: 260px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!loading && users.length === 0">
              <td colspan="7" class="empty-row">尚無帳號</td>
            </tr>
            <tr v-for="u in users" :key="u.id">
              <td class="strong nowrap">
                {{ u.account }}
                <span v-if="isSelf(u)" class="muted">（目前登入）</span>
              </td>
              <td>{{ u.display_name || '—' }}</td>
              <td>
                <span class="tag" :class="u.role === 'admin' ? 'tag-labor' : 'tag-public'">{{ roleLabel(u.role) }}</span>
              </td>
              <td>
                <span class="tag" :class="u.is_active ? 'tag-confirmed' : 'tag-warn'">{{ u.is_active ? '啟用' : '停用' }}</span>
              </td>
              <td>{{ u.created_by || '—' }}</td>
              <td class="nowrap">{{ formatRocDateTime(u.last_login_at) }}</td>
              <td class="nowrap">
                <button type="button" class="btn btn-sm" :disabled="writing || isSelf(u)" @click="onToggleRole(u)">
                  {{ u.role === 'admin' ? '改為一般使用者' : '改為管理者' }}
                </button>
                <button type="button" class="btn btn-sm" :disabled="writing || isSelf(u)" @click="onToggleActive(u)">
                  {{ u.is_active ? '停用' : '啟用' }}
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-danger-outline"
                  :disabled="writing || isSelf(u)"
                  @click="onDelete(u)"
                >
                  {{ pendingId === u.id ? '處理中…' : '刪除' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="loading" class="muted loading-line">載入中…</div>
    </div>
  </section>
</template>
