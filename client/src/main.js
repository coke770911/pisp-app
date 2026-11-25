// @ts-check
import { createApp } from 'vue';
import App from './App.vue';
import { router, handleSessionExpired } from './router/index.js';
import { setUnauthorizedHandler } from './api/http.js';
import './styles/main.css';

// 非略過的請求收到 401 → 清狀態並導回登入頁
setUnauthorizedHandler(handleSessionExpired);

createApp(App).use(router).mount('#app');
