/**
 * adminAuth.js - 站点鉴权逻辑
 * 负责登录/登出、首次初始化密码、会话管理
 *
 * 设计要点:
 * - 管理员密码存储在 KV 的 site_admin_pwd
 * - 登录凭证存储在 localStorage，有效期 7 天
 * - 非登录页自动检查登录状态，未登录跳转 /login
 */

const SITE_AUTH_KEY = 'site_auth_token';
const SITE_AUTH_EXPIRY = 'site_auth_expiry';
const AUTH_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 天

// ==================== 通用：Toast 通知 ====================

function showToastAdmin(message, type) {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'info');
    toast.innerHTML =
        '<span class="toast-icon">' + (icons[type] || icons.info) + '</span>' +
        '<span class="toast-message">' + escapeHtmlAdmin(message) + '</span>' +
        '<button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
    container.appendChild(toast);
    setTimeout(() => {
        if (toast.parentElement) {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }
    }, 3000);
}

function escapeHtmlAdmin(str) {
    if (!str) return '-';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// ==================== 会话管理 ====================

/** 设置登录会话(7天有效期) */
function setAuthSession(token) {
    localStorage.setItem(SITE_AUTH_KEY, token);
    localStorage.setItem(SITE_AUTH_EXPIRY, String(Date.now() + AUTH_DURATION));
}

/** 清除登录会话 */
function clearAuthSession() {
    localStorage.removeItem(SITE_AUTH_KEY);
    localStorage.removeItem(SITE_AUTH_EXPIRY);
}

/** 检查是否已登录 */
function isLoggedIn() {
    const token = localStorage.getItem(SITE_AUTH_KEY);
    const expiry = localStorage.getItem(SITE_AUTH_EXPIRY);
    if (!token || !expiry) return false;
    if (Date.now() > parseInt(expiry)) {
        clearAuthSession();
        return false;
    }
    return true;
}

/** 生成简单 session token（基于时间戳+随机数） */
function generateToken() {
    return 'auth_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
}

// ==================== 通用：API 调用 ====================

/** 检查管理员密码是否已初始化 */
async function checkAdminInit() {
    try {
        const resp = await fetch('/api/admin/check_init');
        const result = await resp.json();
        return result.initialized === true;
    } catch (e) {
        console.error('[AdminAuth] checkAdminInit 异常:', e.message);
        return false;
    }
}

/** 初始化管理员密码 */
async function initAdminPasswordAPI(password) {
    try {
        const resp = await fetch('/api/admin/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        return await resp.json();
    } catch (e) {
        return { success: false, error: '网络异常: ' + e.message };
    }
}

/** 验证管理员密码（登录） */
async function verifyLoginAPI(password) {
    try {
        const resp = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        return await resp.json();
    } catch (e) {
        return { success: false, error: '网络异常: ' + e.message };
    }
}

/** 修改管理员密码 */
async function changeAdminPasswordAPI2(oldPassword, newPassword) {
    try {
        const resp = await fetch('/api/admin/change', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        return await resp.json();
    } catch (e) {
        return { success: false, error: '网络异常: ' + e.message };
    }
}

// ==================== login.html 逻辑 ====================

/** login.html 页面加载时的初始化 */
async function initLoginPage() {
    // 如果已登录，直接跳转到 index.html
    if (isLoggedIn()) {
        window.location.href = 'index.html';
        return;
    }

    const initSection = document.getElementById('initSection');
    const loginSection = document.getElementById('loginSection');

    // 检查是否首次访问（管理员密码是否已设置）
    const initialized = await checkAdminInit();
    if (!initialized) {
        if (initSection) initSection.style.display = 'block';
        if (loginSection) loginSection.style.display = 'none';
    } else {
        if (initSection) initSection.style.display = 'none';
        if (loginSection) loginSection.style.display = 'block';
    }
}

/** 首次初始化管理员密码 */
async function initAdminPassword() {
    const pwd = document.getElementById('initPassword').value.trim();
    const confirmPwd = document.getElementById('initConfirmPassword').value.trim();
    const msgEl = document.getElementById('initMsg');
    const btnEl = document.getElementById('btnInit');

    if (!pwd || !confirmPwd) {
        msgEl.textContent = '请填写所有密码字段';
        msgEl.className = 'login-msg error';
        return;
    }
    if (pwd.length < 6) {
        msgEl.textContent = '密码长度至少 6 位';
        msgEl.className = 'login-msg error';
        return;
    }
    if (pwd !== confirmPwd) {
        msgEl.textContent = '两次输入的密码不一致';
        msgEl.className = 'login-msg error';
        return;
    }

    btnEl.disabled = true;
    msgEl.textContent = '正在设置...';
    msgEl.className = 'login-msg';

    const result = await initAdminPasswordAPI(pwd);
    if (result.success) {
        msgEl.textContent = '✅ 密码设置成功，正在跳转...';
        msgEl.className = 'login-msg success';
        setAuthSession(generateToken());
        setTimeout(() => { window.location.href = 'index.html'; }, 800);
    } else {
        msgEl.textContent = '❌ ' + (result.error || '设置失败');
        msgEl.className = 'login-msg error';
    }
    btnEl.disabled = false;
}

/** 站点登录 */
async function doSiteLogin() {
    const pwd = document.getElementById('loginPassword').value.trim();
    const msgEl = document.getElementById('loginMsg');
    const btnEl = document.getElementById('btnLogin');

    if (!pwd) {
        msgEl.textContent = '请输入管理密码';
        msgEl.className = 'login-msg error';
        return;
    }

    btnEl.disabled = true;
    msgEl.textContent = '正在验证...';
    msgEl.className = 'login-msg';

    const result = await verifyLoginAPI(pwd);
    if (result.success) {
        msgEl.textContent = '✅ 登录成功，正在跳转...';
        msgEl.className = 'login-msg success';
        setAuthSession(generateToken());
        setTimeout(() => { window.location.href = 'index.html'; }, 500);
    } else {
        msgEl.textContent = '❌ ' + (result.error || '密码错误');
        msgEl.className = 'login-msg error';
    }
    btnEl.disabled = false;
}

/** 登录页回车登录 */
document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        const loginPwd = document.getElementById('loginPassword');
        const initPwd = document.getElementById('initPassword');
        if (loginPwd === document.activeElement) {
            e.preventDefault();
            doSiteLogin();
        } else if (initPwd === document.activeElement || document.getElementById('initConfirmPassword') === document.activeElement) {
            e.preventDefault();
            initAdminPassword();
        }
    }
});

// login.html 自动初始化
if (document.body.classList.contains('login-page')) {
    initLoginPage();
}

// ==================== admin.html / index.html 共用：登出 ====================

/** 站点登出 */
function logoutSite() {
    clearAuthSession();
    window.location.href = 'login.html';
}

// ==================== admin.html 专有：路由保护 ====================

/** 检查登录状态，未登录则跳转 */
function requireAuth() {
    if (!isLoggedIn()) {
        window.location.href = 'login.html';
        return false;
    }
    return true;
}

// admin.html 自动检查
if (document.body.classList.contains('admin-page')) {
    if (!requireAuth()) {
        // 已跳转，停止执行
    } else {
        // 登录有效，加载服务商列表
        if (typeof loadProviders === 'function') {
            loadProviders();
        }
    }
}

// index.html 自动检查
if (document.body.classList.contains('index-page')) {
    requireAuth();
}

// ==================== 修改密码弹窗（admin.html 和 index.html 共用） ====================

/** 打开修改密码弹窗 */
function openChangePasswordDialog() {
    const overlay = document.getElementById('changePasswordOverlay');
    if (!overlay) return;
    const oldEl = document.getElementById('oldPasswordInput');
    const newEl = document.getElementById('newPasswordInput');
    const confirmEl = document.getElementById('confirmPasswordInput');
    const msgEl = document.getElementById('changePasswordMsg');
    if (oldEl) oldEl.value = '';
    if (newEl) newEl.value = '';
    if (confirmEl) confirmEl.value = '';
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'login-msg'; }
    overlay.style.display = 'flex';
}

/** 关闭修改密码弹窗 */
function closeChangePasswordDialog() {
    const overlay = document.getElementById('changePasswordOverlay');
    if (overlay) overlay.style.display = 'none';
}

/** 执行修改密码 */
async function doChangePassword() {
    const oldPwd = document.getElementById('oldPasswordInput').value.trim();
    const newPwd = document.getElementById('newPasswordInput').value.trim();
    const confirmPwd = document.getElementById('confirmPasswordInput').value.trim();
    const msgEl = document.getElementById('changePasswordMsg');
    const btnEl = document.getElementById('btnChangePassword');

    if (!oldPwd || !newPwd || !confirmPwd) {
        if (msgEl) { msgEl.textContent = '请填写所有密码字段'; msgEl.className = 'login-msg error'; }
        return;
    }
    if (newPwd.length < 6) {
        if (msgEl) { msgEl.textContent = '新密码长度至少 6 位'; msgEl.className = 'login-msg error'; }
        return;
    }
    if (newPwd !== confirmPwd) {
        if (msgEl) { msgEl.textContent = '两次输入的新密码不一致'; msgEl.className = 'login-msg error'; }
        return;
    }

    btnEl.disabled = true;
    if (msgEl) { msgEl.textContent = '正在修改...'; msgEl.className = 'login-msg'; }

    const result = await changeAdminPasswordAPI2(oldPwd, newPwd);
    if (result.success) {
        showToastAdmin('密码修改成功', 'success');
        if (msgEl) { msgEl.textContent = '✅ 密码修改成功'; msgEl.className = 'login-msg success'; }
        setTimeout(() => closeChangePasswordDialog(), 1500);
    } else {
        if (msgEl) { msgEl.textContent = '❌ ' + (result.error || '修改失败'); msgEl.className = 'login-msg error'; }
        showToastAdmin(result.error || '修改失败', 'error');
    }
    btnEl.disabled = false;
}

// 修改密码弹窗遮罩点击关闭
const cpOverlay = document.getElementById('changePasswordOverlay');
if (cpOverlay) {
    cpOverlay.addEventListener('click', function(e) {
        if (e.target === cpOverlay) closeChangePasswordDialog();
    });
}