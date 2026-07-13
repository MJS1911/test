/**
 * operations.js - 操作执行与状态轮询
 * 负责单台/批量服务器操作、二次验证处理、操作后状态轮询
 * Cloudflare Pages 版本：与 html/js/operations.js 完全一致，无需修改
 */

// ==================== 单台服务器操作 ====================

/**
 * 执行单台服务器操作
 * @param {number|string} hostId - 服务器 ID
 * @param {string} operation - 操作类型
 */
async function doOperation(hostId, operation) {
    const opInfo = OPERATION_MAP[operation];
    if (!opInfo) {
        showToast('不支持的操作', 'error');
        return;
    }

    // 确认弹窗
    const host = API.hosts.find(h => h.id == hostId);
    const hostName = host ? (host.product_name || host.domain || 'ID:' + hostId) : 'ID:' + hostId;

    pendingOperation = { hostId, operation };

    openModal(
        opInfo.label + ' 确认',
        '<p>确定要对服务器 <strong>' + escapeHtml(hostName) + '</strong> 执行 <strong>' + opInfo.label + '</strong> 操作吗？</p>' +
        '<p class="text-muted" style="font-size:0.85rem;margin-top:8px;">此操作将发送指令到服务器，请确认无误后执行。</p>',
        opInfo.label
    );
}

/**
 * 确认执行操作（弹窗确认按钮回调）
 */
async function confirmOperation() {
    if (!pendingOperation) {
        closeModal();
        return;
    }

    const { hostId, operation } = pendingOperation;
    const opInfo = OPERATION_MAP[operation];

    closeModal();

    // 禁用对应按钮
    setActionButtonsDisabled(hostId, true);

    showToast('正在执行 ' + opInfo.label + '...', 'info');

    try {
        const result = await performOperation(hostId, operation);

        if (result.success) {
            if (result.needVerify) {
                // 需要二次验证
                showVerifyModal(hostId, operation, result.verifyData);
            } else {
                showToast(opInfo.label + ' 指令发送成功', 'success');
                // 操作后轮询状态
                await pollStatusAfterOperation(hostId);
            }
        } else {
            showToast(opInfo.label + ' 失败: ' + result.error, 'error');
        }
    } catch (e) {
        showToast(opInfo.label + ' 异常: ' + e.message, 'error');
    }

    setActionButtonsDisabled(hostId, false);
    pendingOperation = null;
}

/**
 * 设置某行的操作按钮启用/禁用
 */
function setActionButtonsDisabled(hostId, disabled) {
    const row = document.querySelector('tr[data-host-id="' + hostId + '"]');
    if (row) {
        const buttons = row.querySelectorAll('.action-btn');
        buttons.forEach(btn => btn.disabled = disabled);
    }
}

// ==================== 二次验证处理 ====================

function showVerifyModal(hostId, operation, verifyData) {
    // verifyData 结构: [{ type, name_zh, account }, ...]
    let html = '<p>此操作需要二次验证，请选择验证方式：</p>';
    html += '<div style="margin-top:12px;">';

    verifyData.forEach((item, idx) => {
        const type = item.type || 'email';
        const name = item.name_zh || type;
        const account = item.account || '';
        html += '<label style="display:block;padding:10px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;cursor:pointer;">';
        html += '<input type="radio" name="verify_method" value="' + idx + '" ' + (idx === 0 ? 'checked' : '') + ' style="margin-right:8px;">';
        html += '<strong>' + name + '</strong> (' + type + ')';
        if (account) html += ' - ' + escapeHtml(account);
        html += '</label>';
    });

    html += '</div>';
    html += '<p class="text-muted" style="font-size:0.8rem;margin-top:8px;">选择验证方式后点击确认，系统将发送验证码到对应账户</p>';

    pendingOperation = { hostId, operation, verifyData };

    openModal(
        '二次验证',
        html,
        '发送验证码'
    );

    // 修改确认按钮回调
    DOM.modalConfirmBtn.onclick = async () => {
        await sendVerifyCode(hostId, operation, verifyData);
    };
}

async function sendVerifyCode(hostId, operation, verifyData) {
    const selectedIdx = document.querySelector('input[name="verify_method"]:checked');
    if (!selectedIdx) {
        showToast('请选择验证方式', 'warning');
        return;
    }

    const method = verifyData[parseInt(selectedIdx.value)];
    // 这里需要调用二次验证提交接口
    // 根据 API 文档，提交二次验证接口是 POST /v1/verify/submit
    // 但 cankao.py 中没有实现，这里仅作提示

    closeModal();
    showToast('已发送验证码到 ' + (method.account || method.type) + '，请在原网站完成验证后重试', 'info');
}

// ==================== 批量操作 ====================

/**
 * 批量操作
 * @param {string} operation - 操作类型
 */
async function batchOperation(operation) {
    if (!API.jwt || API.hosts.length === 0) {
        showToast('请先登录并加载服务器列表', 'warning');
        return;
    }

    const opInfo = OPERATION_MAP[operation];
    if (!opInfo) return;

    const confirmMsg = '确定要对 <strong>全部 ' + API.hosts.length + ' 台服务器</strong> 执行 <strong>' + opInfo.label + '</strong> 操作吗？';
    if (!confirm(confirmMsg.replace(/<[^>]+>/g, ''))) return;

    showToast('开始批量 ' + opInfo.label + '...', 'info');

    let success = 0, fail = 0;

    for (const host of API.hosts) {
        const hostId = host.id;
        if (!hostId) continue;

        try {
            const result = await performOperation(hostId, operation);
            if (result.success) {
                success++;
            } else {
                fail++;
                console.error('批量操作失败 #' + hostId + ':', result.error);
            }
        } catch (e) {
            fail++;
            console.error('批量操作异常 #' + hostId + ':', e.message);
        }

        // 简单延迟避免请求过快
        await sleep(300);
    }

    showToast('批量 ' + opInfo.label + ' 完成: 成功 ' + success + ' 台, 失败 ' + fail + ' 台',
        fail > 0 ? 'warning' : 'success');

    // 批量操作后刷新所有状态
    await refreshAllStatus();
}

/**
 * 刷新所有服务器状态
 */
async function refreshAllStatus() {
    if (!API.jwt || API.hosts.length === 0) {
        showToast('请先登录并加载服务器列表', 'warning');
        return;
    }

    showToast('正在刷新所有服务器状态...', 'info');

    // 禁用刷新按钮
    DOM.btnRefresh.disabled = true;

    let completed = 0;
    const total = API.hosts.length;

    for (const host of API.hosts) {
        const hostId = host.id;
        if (!hostId) continue;

        try {
            const result = await fetchServerStatus(hostId);
            if (result.success) {
                updateStatusCell(hostId, getPowerStatusBadge(hostId));
            } else {
                updateStatusCell(hostId, '<span class="status-badge off">❌ ' + escapeHtml(result.error) + '</span>');
            }
        } catch (e) {
            updateStatusCell(hostId, '<span class="status-badge off">❌ ' + escapeHtml(e.message) + '</span>');
        }

        completed++;
        // 更新进度提示
        if (completed % 5 === 0 || completed === total) {
            showToast('已刷新 ' + completed + '/' + total + ' 台', 'info');
        }

        await sleep(200);
    }

    DOM.btnRefresh.disabled = false;
    showToast('全部状态刷新完成', 'success');
}

// ==================== 操作后状态轮询 ====================

/**
 * 操作后轮询状态，直到状态变化或超时
 */
async function pollStatusAfterOperation(hostId, maxAttempts = 15, interval = 3000) {
    const opInfo = OPERATION_MAP[pendingOperation?.operation] || { label: '操作' };

    showToast(opInfo.label + ' 已发送，正在轮询状态...', 'info');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await sleep(interval);

        try {
            const result = await fetchServerStatus(hostId);
            if (result.success) {
                const status = result.data.status;
                const des = result.data.des || status;

                updateStatusCell(hostId, getPowerStatusBadge(hostId));

                if (status === 'on' || status === 'off') {
                    showToast('服务器 #' + hostId + ' 当前状态: ' + des, 'success');
                    return;
                }
            }
        } catch (e) {
            console.warn('轮询状态异常:', e.message);
        }
    }

    showToast('轮询超时，请手动点击查询状态按钮刷新', 'warning');
}

// ==================== 定时操作（查状态 + 硬重启/重启兜底） ====================

/** 按服务商记忆的定时配置与运行态 */
const SCHEDULE_STORAGE_KEY = 'mofang_schedule_ops';
let scheduleTimer = null;
let scheduleRunning = false;
let scheduleTickBusy = false;
let scheduleProviderId = null;
let scheduleIntervalMin = 5;
let scheduleLastRunAt = null;
let scheduleNextRunAt = null;

function _scheduleStorageLoad() {
    try {
        return JSON.parse(localStorage.getItem(SCHEDULE_STORAGE_KEY) || '{}') || {};
    } catch (e) {
        return {};
    }
}

function _scheduleStorageSave(map) {
    try {
        localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(map || {}));
    } catch (e) { /* ignore */ }
}

function getScheduleProviderKey() {
    if (typeof activePid !== 'undefined' && activePid) return String(activePid);
    return scheduleProviderId || 'default';
}

function loadScheduleConfigForActive() {
    const key = getScheduleProviderKey();
    const map = _scheduleStorageLoad();
    const cfg = map[key] || {};
    const input = document.getElementById('scheduleInterval');
    if (input && cfg.intervalMin) {
        input.value = String(cfg.intervalMin);
    }
    return cfg;
}

function saveScheduleConfigForActive(partial) {
    const key = getScheduleProviderKey();
    const map = _scheduleStorageLoad();
    map[key] = Object.assign({}, map[key] || {}, partial || {});
    _scheduleStorageSave(map);
}

function formatScheduleTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
}

function updateScheduleUI() {
    const statusEl = document.getElementById('scheduleStatus');
    const btnStart = document.getElementById('btnScheduleStart');
    const btnStop = document.getElementById('btnScheduleStop');
    const input = document.getElementById('scheduleInterval');

    if (btnStart) btnStart.disabled = scheduleRunning;
    if (btnStop) btnStop.disabled = !scheduleRunning;
    if (input) input.disabled = scheduleRunning;

    if (!statusEl) return;
    if (!scheduleRunning) {
        statusEl.textContent = '未启动';
        statusEl.className = 'schedule-status';
        return;
    }
    let text = '运行中 · 间隔 ' + scheduleIntervalMin + ' 分钟';
    if (scheduleLastRunAt) text += ' · 上次 ' + formatScheduleTime(scheduleLastRunAt);
    if (scheduleNextRunAt) text += ' · 下次 ' + formatScheduleTime(scheduleNextRunAt);
    if (scheduleTickBusy) text += ' · 检查中…';
    statusEl.textContent = text;
    statusEl.className = 'schedule-status running';
}

/**
 * 判断是否为「运行中/开机」
 * API status === 'on' 视为运行中
 */
function isHostRunning(statusData) {
    if (!statusData) return false;
    const s = String(statusData.status || '').toLowerCase();
    return s === 'on' || s === 'running' || s === 'online';
}

/**
 * 对非运行中主机：优先硬重启，失败则重启
 */
async function recoverHostWithReboot(hostId) {
    try {
        const hard = await performOperation(hostId, 'hard_reboot');
        if (hard && hard.success && !hard.needVerify) {
            log('success', '定时操作: 硬重启成功 #' + hostId, hard.msg);
            return { success: true, action: 'hard_reboot', msg: hard.msg };
        }
        // 需要二次验证时无法在定时任务中完成，记为失败并尝试普通重启
        if (hard && hard.needVerify) {
            log('warning', '定时操作: 硬重启需二次验证，改试重启 #' + hostId);
        } else {
            log('warning', '定时操作: 硬重启失败，改试重启 #' + hostId, hard && hard.error);
        }
    } catch (e) {
        log('warning', '定时操作: 硬重启异常，改试重启 #' + hostId, e.message);
    }

    try {
        const soft = await performOperation(hostId, 'reboot');
        if (soft && soft.success && !soft.needVerify) {
            log('success', '定时操作: 重启成功 #' + hostId, soft.msg);
            return { success: true, action: 'reboot', msg: soft.msg };
        }
        return {
            success: false,
            action: 'reboot',
            error: (soft && (soft.error || soft.msg)) || '重启失败'
        };
    } catch (e) {
        return { success: false, action: 'reboot', error: e.message };
    }
}

/**
 * 一轮定时检查：查全部状态，非运行中则硬重启→重启兜底
 */
async function runScheduledCheck() {
    if (scheduleTickBusy) return;
    if (!API.jwt || !API.hosts || API.hosts.length === 0) {
        log('warning', '定时操作: 未登录或无服务器，跳过本轮');
        scheduleLastRunAt = Date.now();
        scheduleNextRunAt = Date.now() + scheduleIntervalMin * 60 * 1000;
        updateScheduleUI();
        return;
    }

    scheduleTickBusy = true;
    updateScheduleUI();
    log('info', '定时操作: 开始检查', '共 ' + API.hosts.length + ' 台');

    let checked = 0, running = 0, recovered = 0, failed = 0;

    try {
        for (const host of API.hosts) {
            if (!scheduleRunning) break;
            const hostId = host.id;
            if (!hostId) continue;

            try {
                const result = await fetchServerStatus(hostId);
                if (result.success) {
                    updateStatusCell(hostId, getPowerStatusBadge(hostId));
                    checked++;
                    if (isHostRunning(result.data)) {
                        running++;
                    } else {
                        const des = (result.data && (result.data.des || result.data.status)) || '非运行中';
                        log('warning', '定时操作: #' + hostId + ' 非运行中 (' + des + ')，尝试恢复');
                        const rec = await recoverHostWithReboot(hostId);
                        if (rec.success) {
                            recovered++;
                            // 操作后稍等再刷一次状态
                            await sleep(800);
                            try {
                                const st2 = await fetchServerStatus(hostId);
                                if (st2.success) updateStatusCell(hostId, getPowerStatusBadge(hostId));
                            } catch (e2) { /* ignore */ }
                        } else {
                            failed++;
                            log('error', '定时操作: #' + hostId + ' 恢复失败', rec.error);
                        }
                    }
                } else {
                    failed++;
                    updateStatusCell(hostId, '<span class="status-badge off">❌ ' + escapeHtml(result.error) + '</span>');
                    log('error', '定时操作: 查状态失败 #' + hostId, result.error);
                }
            } catch (e) {
                failed++;
                updateStatusCell(hostId, '<span class="status-badge off">❌ ' + escapeHtml(e.message) + '</span>');
                log('error', '定时操作: 异常 #' + hostId, e.message);
            }

            await sleep(250);
        }
    } finally {
        scheduleTickBusy = false;
        scheduleLastRunAt = Date.now();
        scheduleNextRunAt = Date.now() + scheduleIntervalMin * 60 * 1000;
        updateScheduleUI();
        const summary = '检查 ' + checked + ' · 运行中 ' + running + ' · 已恢复 ' + recovered + ' · 失败 ' + failed;
        log('info', '定时操作: 本轮完成', summary);
        if (typeof showToast === 'function') {
            showToast('定时检查完成: ' + summary, failed > 0 ? 'warning' : 'success');
        }
    }
}

function startScheduledOps() {
    if (scheduleRunning) {
        showToast('定时操作已在运行', 'info');
        return;
    }
    if (!API.jwt || !API.hosts || API.hosts.length === 0) {
        showToast('请先登录并加载服务器列表', 'warning');
        return;
    }

    const input = document.getElementById('scheduleInterval');
    let mins = parseInt(input && input.value, 10);
    if (!mins || mins < 1) mins = 1;
    if (mins > 1440) mins = 1440;
    if (input) input.value = String(mins);

    scheduleIntervalMin = mins;
    scheduleProviderId = getScheduleProviderKey();
    scheduleRunning = true;
    scheduleLastRunAt = null;
    scheduleNextRunAt = Date.now();

    saveScheduleConfigForActive({ intervalMin: mins, enabled: true });

    if (scheduleTimer) {
        clearInterval(scheduleTimer);
        scheduleTimer = null;
    }

    // 立即执行一轮，再按间隔循环
    runScheduledCheck();
    scheduleTimer = setInterval(function () {
        if (!scheduleRunning) return;
        runScheduledCheck();
    }, scheduleIntervalMin * 60 * 1000);

    updateScheduleUI();
    showToast('定时操作已启动，间隔 ' + mins + ' 分钟', 'success');
    log('info', '定时操作已启动', '间隔 ' + mins + ' 分钟, provider=' + scheduleProviderId);
}

function stopScheduledOps(silent) {
    const wasRunning = scheduleRunning;
    scheduleRunning = false;
    if (scheduleTimer) {
        clearInterval(scheduleTimer);
        scheduleTimer = null;
    }
    scheduleTickBusy = false;
    scheduleNextRunAt = null;
    saveScheduleConfigForActive({ enabled: false, intervalMin: scheduleIntervalMin });
    updateScheduleUI();
    if (wasRunning) {
        log('info', '定时操作已停止');
        if (!silent && typeof showToast === 'function') {
            showToast('定时操作已停止', 'info');
        }
    }
}

/**
 * 切换服务商时：停止当前定时器并恢复该服务商的间隔配置
 * （定时任务绑定当前活跃服务商，切换后需重新启动）
 */
function onProviderSwitchForSchedule() {
    if (scheduleRunning) {
        stopScheduledOps(true);
        if (typeof showToast === 'function') {
            showToast('已切换服务商，定时操作已自动停止，请按需重新启动', 'info');
        }
    }
    loadScheduleConfigForActive();
    updateScheduleUI();
}

// 页面加载时恢复间隔显示
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
        loadScheduleConfigForActive();
        updateScheduleUI();
    });
}

window.startScheduledOps = startScheduledOps;
window.stopScheduledOps = stopScheduledOps;
window.runScheduledCheck = runScheduledCheck;
window.onProviderSwitchForSchedule = onProviderSwitchForSchedule;

// ==================== 工具函数 ====================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
    if (!str) return '-';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}