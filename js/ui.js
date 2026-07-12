/**
 * ui.js - 界面渲染与交互逻辑
 * 负责 DOM 操作、表格渲染、状态更新、Toast 通知、弹窗管理
 * Cloudflare Pages 版本：与 html/js/ui.js 完全一致，无需修改
 */

// ==================== DOM 引用缓存 ====================
const $ = (id) => document.getElementById(id);

const DOM = {
    topbarStatus: $('topbarStatus'),
    apiBaseUrl: $('apiBaseUrl'),
    account: $('account'),
    apiKey: $('apiKey'),
    btnLogin: $('btnLogin'),
    btnLogout: $('btnLogout'),
    loginMsg: $('loginMsg'),
    panelBatch: $('panelBatch'),
    serverCount: $('serverCount'),
    btnRefresh: $('btnRefresh'),
    loadingArea: $('loadingArea'),
    emptyState: $('emptyState'),
    tableWrapper: $('tableWrapper'),
    serverTbody: $('serverTbody'),
    modalOverlay: $('modalOverlay'),
    modalTitle: $('modalTitle'),
    modalBody: $('modalBody'),
    modalConfirmBtn: $('modalConfirmBtn'),
    toastContainer: $('toastContainer'),
    // 管理密码验证相关
    adminVerifyOverlay: $('adminVerifyOverlay'),
    adminPasswordInput: $('adminPasswordInput'),
    adminVerifyMsg: $('adminVerifyMsg'),
    btnAdminVerify: $('btnAdminVerify'),
    changePasswordOverlay: $('changePasswordOverlay'),
    oldPasswordInput: $('oldPasswordInput'),
    newPasswordInput: $('newPasswordInput'),
    confirmPasswordInput: $('confirmPasswordInput'),
    changePasswordMsg: $('changePasswordMsg'),
    btnChangePassword: $('btnChangePassword'),
};

// ==================== 登录/登出 ====================

async function doLogin() {
    const baseUrl = DOM.apiBaseUrl.value.trim();
    const account = DOM.account.value.trim();
    const apiKey = DOM.apiKey.value.trim();

    if (!baseUrl || !account || !apiKey) {
        showLoginMsg('请填写完整的 API 配置信息', 'error');
        return;
    }

    // Cloudflare Pages 版本：baseUrl 固定为 /api/，忽略用户输入
    // 但保留输入框以便用户知道配置的是哪个站点
    API.baseUrl = '/api/';

    DOM.btnLogin.disabled = true;
    showLoginMsg('正在登录...', '');

    try {
        const result = await loginAPI(account, apiKey);
        if (result.success) {
            showLoginMsg('✅ 登录成功！', 'success');
            // 登录成功后保存凭证到 KV
            await saveAuth(account, apiKey, baseUrl);
            onLoginSuccess();
        } else {
            showLoginMsg('❌ ' + result.error, 'error');
        }
    } catch (e) {
        showLoginMsg('❌ ' + e.message, 'error');
    }

    DOM.btnLogin.disabled = false;
}

function onLoginSuccess() {
    // 切换 UI 状态
    DOM.btnLogin.style.display = 'none';
    DOM.btnLogout.style.display = 'block';
    DOM.panelBatch.style.display = 'block';
    DOM.btnRefresh.disabled = false;
    DOM.emptyState.style.display = 'none';

    // 更新顶部状态
    DOM.topbarStatus.textContent = '已连接';
    DOM.topbarStatus.className = 'topbar-status connected';

    // 自动加载服务器列表
    loadServers();
}

function doLogout() {
    API.jwt = null;
    API.hosts = [];
    API.statusCache = {};

    DOM.btnLogin.style.display = 'block';
    DOM.btnLogout.style.display = 'none';
    DOM.panelBatch.style.display = 'none';
    DOM.btnRefresh.disabled = true;
    DOM.tableWrapper.style.display = 'none';
    DOM.emptyState.style.display = 'block';
    DOM.emptyState.innerHTML = '<p>👆 请先在左侧配置 API 信息并登录</p>';
    DOM.serverCount.textContent = '共 0 台';

    DOM.topbarStatus.textContent = '未连接';
    DOM.topbarStatus.className = 'topbar-status';

    showLoginMsg('已登出', '');
    showToast('已安全登出', 'info');
    
    // 登出时清除云端凭证
    clearAuth();
}

function showLoginMsg(msg, type) {
    DOM.loginMsg.textContent = msg;
    DOM.loginMsg.className = 'login-msg ' + (type || '');
}

// ==================== 服务器列表加载 ====================

async function loadServers() {
    if (!API.jwt) {
        showToast('请先登录', 'warning');
        return;
    }

    showLoading(true);
    DOM.emptyState.style.display = 'none';
    DOM.tableWrapper.style.display = 'none';

    try {
        const result = await fetchHosts(1, 200);
        if (result.success) {
            renderServerTable(result.hosts);
            DOM.serverCount.textContent = '共 ' + result.total + ' 台';
            showToast('已加载 ' + result.total + ' 台服务器', 'success');
        } else {
            DOM.emptyState.style.display = 'block';
            DOM.emptyState.innerHTML = '<p>❌ ' + result.error + '</p>';
            showToast(result.error, 'error');
        }
    } catch (e) {
        DOM.emptyState.style.display = 'block';
        DOM.emptyState.innerHTML = '<p>❌ ' + e.message + '</p>';
        showToast(e.message, 'error');
    }

    showLoading(false);
}

function showLoading(show) {
    DOM.loadingArea.style.display = show ? 'flex' : 'none';
}

// ==================== 表格渲染 ====================

/**
 * 状态显示映射
 */
const STATUS_MAP = {
    'Active':    { label: '已激活',  cssClass: 'on' },
    'Pending':   { label: '待开通',  cssClass: 'unknown' },
    'Suspended': { label: '已暂停',  cssClass: 'off' },
    'Cancelled': { label: '被取消',  cssClass: 'off' },
    'Fraud':     { label: '有欺诈',  cssClass: 'off' },
    'Deleted':   { label: '被删除',  cssClass: 'off' },
};

function getDomainStatusBadge(domainstatus) {
    const info = STATUS_MAP[domainstatus] || { label: domainstatus || '未知', cssClass: 'unknown' };
    return '<span class="status-badge ' + info.cssClass + '">' +
        '<span class="status-dot"></span>' + info.label + '</span>';
}

function getPowerStatusBadge(hostId) {
    const cached = API.statusCache[hostId];
    if (!cached) {
        return '<span class="status-badge loading">⏳ 未查询</span>';
    }
    const status = cached.status;
    const des = cached.des || status;
    if (status === 'on') {
        return '<span class="status-badge on"><span class="status-dot"></span>' + des + '</span>';
    } else if (status === 'off') {
        return '<span class="status-badge off"><span class="status-dot"></span>' + des + '</span>';
    } else if (status === 'error') {
        return '<span class="status-badge off">❌ ' + des + '</span>';
    }
    return '<span class="status-badge unknown"><span class="status-dot"></span>' + des + '</span>';
}

function formatDate(timestamp) {
    if (!timestamp || timestamp === '0') return '-';
    const d = new Date(parseInt(timestamp) * 1000);
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

function renderServerTable(hosts) {
    if (!hosts || hosts.length === 0) {
        DOM.tableWrapper.style.display = 'none';
        DOM.emptyState.style.display = 'block';
        DOM.emptyState.innerHTML = '<p>📭 没有找到服务器</p>';
        return;
    }

    DOM.tableWrapper.style.display = 'block';
    DOM.emptyState.style.display = 'none';

    let html = '';
    hosts.forEach(host => {
        const id = host.id || '-';
        const productName = host.product_name || host.domain || '-';
        const domain = host.domain || '-';
        const dedicatedip = host.dedicatedip || '-';
        const domainstatus = host.domainstatus || '-';
        const nextduedate = formatDate(host.nextduedate);
        const amount = host.amount || host.firstpaymentamount || '-';
        const billingcycle = host.billingcycle || '';

        html += '<tr data-host-id="' + id + '">';
        html += '<td><strong>' + id + '</strong></td>';
        html += '<td>' + escapeHtml(productName) + '</td>';
        html += '<td>' + escapeHtml(domain) + '</td>';
        html += '<td><code>' + escapeHtml(dedicatedip) + '</code></td>';
        html += '<td>' + getDomainStatusBadge(domainstatus) + '</td>';
        html += '<td>' + nextduedate + '</td>';
        html += '<td>' + amount + (billingcycle ? ' / ' + billingcycle : '') + '</td>';
        html += '<td class="action-cell">' + renderActionButtons(id) + '</td>';
        html += '</tr>';
    });

    DOM.serverTbody.innerHTML = html;
}

function renderActionButtons(hostId) {
    return '<button class="action-btn btn-success" onclick="checkStatus(' + hostId + ')" title="查询状态">📊</button>' +
        '<button class="action-btn btn-primary" onclick="doOperation(' + hostId + ', \'on\')" title="开机">▶️</button>' +
        '<button class="action-btn btn-warning" onclick="doOperation(' + hostId + ', \'off\')" title="关机">⏹️</button>' +
        '<button class="action-btn btn-info" onclick="doOperation(' + hostId + ', \'reboot\')" title="重启">🔄</button>' +
        '<button class="action-btn btn-danger" onclick="doOperation(' + hostId + ', \'hard_reboot\')" title="硬重启">⚡</button>';
}

function escapeHtml(str) {
    if (!str) return '-';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ==================== 状态查询 ====================

async function checkStatus(hostId) {
    // 更新对应行的状态列为加载中
    updateStatusCell(hostId, '<span class="status-badge loading">⏳ 查询中...</span>');

    try {
        const result = await fetchServerStatus(hostId);
        if (result.success) {
            updateStatusCell(hostId, getPowerStatusBadge(hostId));
            const des = result.data.des || result.data.status;
            showToast('服务器 #' + hostId + ' 状态: ' + des, 'success');
        } else {
            updateStatusCell(hostId, '<span class="status-badge off">❌ 查询失败</span>');
            showToast('查询失败: ' + result.error, 'error');
        }
    } catch (e) {
        updateStatusCell(hostId, '<span class="status-badge off">❌ ' + escapeHtml(e.message) + '</span>');
        showToast(e.message, 'error');
    }
}

function updateStatusCell(hostId, html) {
    const row = document.querySelector('tr[data-host-id="' + hostId + '"]');
    if (row) {
        const cells = row.querySelectorAll('td');
        // 状态列是第5列（索引4）
        if (cells.length >= 5) {
            cells[4].innerHTML = html;
        }
    }
}

// ==================== 弹窗管理 ====================

let pendingOperation = null;  // { hostId, operation }

function openModal(title, body, confirmText) {
    DOM.modalTitle.textContent = title;
    DOM.modalBody.innerHTML = body;
    DOM.modalConfirmBtn.textContent = confirmText || '确认执行';
    DOM.modalOverlay.style.display = 'flex';
}

function closeModal() {
    DOM.modalOverlay.style.display = 'none';
    pendingOperation = null;
}

// 点击遮罩关闭
DOM.modalOverlay.addEventListener('click', function(e) {
    if (e.target === DOM.modalOverlay) {
        closeModal();
    }
});

// ==================== Toast 通知 ====================

function showToast(message, type) {
    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️',
    };

    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'info');
    toast.innerHTML =
        '<span class="toast-icon">' + (icons[type] || icons.info) + '</span>' +
        '<span class="toast-message">' + escapeHtml(message) + '</span>' +
        '<button class="toast-close" onclick="this.parentElement.remove()">✕</button>';

    DOM.toastContainer.appendChild(toast);

    // 3秒后自动消失
    setTimeout(() => {
        if (toast.parentElement) {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }
    }, 3000);
}

// ==================== 键盘快捷键 ====================

document.addEventListener('keydown', function(e) {
    // Enter 键登录
    if (e.key === 'Enter' && document.activeElement === DOM.apiKey) {
        e.preventDefault();
        doLogin();
    }
    // Escape 关闭弹窗
    if (e.key === 'Escape' && DOM.modalOverlay.style.display === 'flex') {
        closeModal();
    }
});

// ==================== 系统日志窗口 ====================

function clearLogs() {
    const logContent = document.getElementById('logContent');
    if (logContent) logContent.innerHTML = '';
}

function toggleLogPanel() {
    const panel = document.getElementById('logPanel');
    if (panel) panel.classList.toggle('collapsed');
}

// 监听 api-log 事件，渲染到日志窗口
window.addEventListener('api-log', function(e) {
    const { timestamp, level, message, data } = e.detail;
    const logContent = document.getElementById('logContent');
    if (!logContent) return;

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = timestamp;

    const levelSpan = document.createElement('span');
    levelSpan.className = 'log-level ' + level;
    levelSpan.textContent = level;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-message ' + level;
    msgSpan.textContent = message;

    entry.appendChild(timeSpan);
    entry.appendChild(levelSpan);
    entry.appendChild(msgSpan);

    if (data) {
        const detailDiv = document.createElement('div');
        detailDiv.className = 'log-detail';
        detailDiv.textContent = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
        entry.appendChild(detailDiv);
    }

    logContent.appendChild(entry);
    logContent.scrollTop = logContent.scrollHeight;
});

// ==================== 管理密码验证 ====================

/**
 * 验证管理密码
 */
async function verifyAdminPassword() {
    const password = DOM.adminPasswordInput.value.trim();
    
    if (!password) {
        DOM.adminVerifyMsg.textContent = '请输入管理密码';
        DOM.adminVerifyMsg.className = 'login-msg error';
        return;
    }

    DOM.btnAdminVerify.disabled = true;
    DOM.adminVerifyMsg.textContent = '正在验证...';
    DOM.adminVerifyMsg.className = 'login-msg';

    try {
        const result = await verifyAdminPasswordAPI(password);
        if (result.success) {
            DOM.adminVerifyMsg.textContent = '✅ 验证成功';
            DOM.adminVerifyMsg.className = 'login-msg success';
            // 设置 Cookie 标记已验证（有效期 24 小时）
            document.cookie = 'admin_verified=true; path=/; max-age=86400; SameSite=Lax';
            // 隐藏验证弹窗，显示主界面
            setTimeout(() => {
                DOM.adminVerifyOverlay.style.display = 'none';
            }, 500);
        } else {
            DOM.adminVerifyMsg.textContent = '❌ ' + (result.error || '密码错误');
            DOM.adminVerifyMsg.className = 'login-msg error';
        }
    } catch (e) {
        DOM.adminVerifyMsg.textContent = '❌ ' + e.message;
        DOM.adminVerifyMsg.className = 'login-msg error';
    }

    DOM.btnAdminVerify.disabled = false;
}

/**
 * 修改管理密码
 */
async function changeAdminPassword() {
    const oldPassword = DOM.oldPasswordInput.value.trim();
    const newPassword = DOM.newPasswordInput.value.trim();
    const confirmPassword = DOM.confirmPasswordInput.value.trim();

    if (!oldPassword || !newPassword || !confirmPassword) {
        DOM.changePasswordMsg.textContent = '请填写所有密码字段';
        DOM.changePasswordMsg.className = 'login-msg error';
        return;
    }

    if (newPassword.length < 6) {
        DOM.changePasswordMsg.textContent = '新密码长度至少 6 位';
        DOM.changePasswordMsg.className = 'login-msg error';
        return;
    }

    if (newPassword !== confirmPassword) {
        DOM.changePasswordMsg.textContent = '两次输入的新密码不一致';
        DOM.changePasswordMsg.className = 'login-msg error';
        return;
    }

    DOM.btnChangePassword.disabled = true;
    DOM.changePasswordMsg.textContent = '正在修改...';
    DOM.changePasswordMsg.className = 'login-msg';

    try {
        const result = await changeAdminPasswordAPI(oldPassword, newPassword);
        if (result.success) {
            DOM.changePasswordMsg.textContent = '✅ 密码修改成功';
            DOM.changePasswordMsg.className = 'login-msg success';
            showToast('管理密码已修改', 'success');
            setTimeout(() => {
                closeChangePassword();
            }, 1500);
        } else {
            DOM.changePasswordMsg.textContent = '❌ ' + (result.error || '修改失败');
            DOM.changePasswordMsg.className = 'login-msg error';
        }
    } catch (e) {
        DOM.changePasswordMsg.textContent = '❌ ' + e.message;
        DOM.changePasswordMsg.className = 'login-msg error';
    }

    DOM.btnChangePassword.disabled = false;
}

/**
 * 打开修改密码弹窗
 */
function openChangePassword() {
    DOM.oldPasswordInput.value = '';
    DOM.newPasswordInput.value = '';
    DOM.confirmPasswordInput.value = '';
    DOM.changePasswordMsg.textContent = '';
    DOM.changePasswordMsg.className = 'login-msg';
    DOM.changePasswordOverlay.style.display = 'flex';
}

/**
 * 关闭修改密码弹窗
 */
function closeChangePassword() {
    DOM.changePasswordOverlay.style.display = 'none';
}

// 点击遮罩关闭修改密码弹窗
if (DOM.changePasswordOverlay) {
    DOM.changePasswordOverlay.addEventListener('click', function(e) {
        if (e.target === DOM.changePasswordOverlay) {
            closeChangePassword();
        }
    });
}

// 管理密码输入框回车验证
if (DOM.adminPasswordInput) {
    DOM.adminPasswordInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            verifyAdminPassword();
        }
    });
}

// ==================== 页面初始化：自动加载凭证 ====================

/**
 * 页面加载完成后，尝试从 KV 读取上次保存的凭证并自动填充表单
 * 如果 KV 未配置或读取失败，不影响正常使用
 */
(async function initAuthFromKV() {
    try {
        const saved = await loadAuth();
        if (saved && saved.account && saved.apiKey) {
            DOM.account.value = saved.account;
            DOM.apiKey.value = saved.apiKey;
            if (saved.baseUrl) {
                DOM.apiBaseUrl.value = saved.baseUrl;
            }
            showLoginMsg('📋 已加载上次保存的凭证 (' + saved.account + ')，可直接登录', 'success');
            console.log('[UI] 从 KV 加载凭证成功:', saved.account);
        } else {
            console.log('[UI] KV 中无保存的凭证，请手动填写');
        }
    } catch (e) {
        // KV 未配置或网络异常，静默处理
        console.log('[UI] 凭证加载跳过:', e.message);
    }
})();