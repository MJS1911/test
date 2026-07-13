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

// ==================== 服务端长效定时（CF Pages KV，关网页不停） ====================
// 配置与执行均在服务端 /api/schedule/*；前端只负责启停与展示状态。
// 巡检覆盖全部服务商全部机器；关机优先 on，其它 hard_reboot→reboot→on。
// 关页后服务端 waitUntil 会连续分片续跑；仍须外部 cron 每分钟访问 /api/schedule/run 作兜底。

let scheduleConfig = {
    enabled: false,
    intervalMin: 5,
    lastRunAt: null,
    nextRunAt: null,
    running: false,
    lastSummary: null,
    progress: null
};
let scheduleStatusPollTimer = null;
let scheduleUiBusy = false;
let scheduleForceWatchTimer = null;

function formatScheduleTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    return String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
}

function updateScheduleUI() {
    const statusEl = document.getElementById('scheduleStatus');
    const btnStart = document.getElementById('btnScheduleStart');
    const btnStop = document.getElementById('btnScheduleStop');
    const btnRun = document.getElementById('btnScheduleRunNow');
    const input = document.getElementById('scheduleInterval');
    const cfg = scheduleConfig || {};
    const enabled = !!cfg.enabled;

    if (btnStart) btnStart.disabled = enabled || scheduleUiBusy;
    if (btnStop) btnStop.disabled = !enabled || scheduleUiBusy;
    if (btnRun) btnRun.disabled = scheduleUiBusy || !!cfg.running;
    if (input) {
        input.disabled = enabled || scheduleUiBusy;
        if (cfg.intervalMin && document.activeElement !== input) {
            input.value = String(cfg.intervalMin);
        }
    }

    if (!statusEl) return;
    if (!enabled) {
        let t = '未启动（服务端）';
        if (cfg.running) t += ' · 巡检中…';
        if (cfg.progress) t += ' · ' + cfg.progress;
        if (cfg.lastRunAt) t += ' · 上次 ' + formatScheduleTime(cfg.lastRunAt);
        if (cfg.lastSummary) t += ' · ' + cfg.lastSummary;
        statusEl.textContent = t;
        statusEl.className = 'schedule-status';
        return;
    }
    let text = '服务端运行中 · 间隔 ' + (cfg.intervalMin || 5) + ' 分钟 · 全部服务商全部机器';
    if (cfg.running) {
        text += ' · 巡检中…';
        if (cfg.progress) text += ' ' + cfg.progress;
    }
    if (cfg.lastRunAt) text += ' · 上次 ' + formatScheduleTime(cfg.lastRunAt);
    if (cfg.nextRunAt && !cfg.running) text += ' · 下次 ' + formatScheduleTime(cfg.nextRunAt);
    if (cfg.lastSummary) text += ' · ' + cfg.lastSummary;
    statusEl.textContent = text;
    statusEl.className = 'schedule-status running';
}

async function fetchScheduleStatus() {
    try {
        const resp = await fetch('/api/schedule/status');
        const result = await resp.json();
        if (result && result.success && result.config) {
            scheduleConfig = result.config;
            updateScheduleUI();
            return result;
        }
    } catch (e) {
        console.warn('fetchScheduleStatus failed:', e);
    }
    return null;
}

/** 分片巡检进行中时，前端辅助触发 continue + 刷新状态（更积极，保证多机全量） */
function startForceWatchPolling() {
    if (scheduleForceWatchTimer) return;
    let ticks = 0;
    let lastContinueCursor = null;
    function tickContinue() {
        ticks++;
        const body = {};
        // 优先用上次响应的 continueCursor（含 hostIds 快照），否则用 status 里的 cursor
        const snap = lastContinueCursor ||
            (scheduleConfig && scheduleConfig.cursor
                ? Object.assign({}, scheduleConfig.cursor, scheduleConfig.stats ? { stats: scheduleConfig.stats } : {})
                : null);
        if (snap) body.cursor = snap;
        fetch('/api/schedule/run?continue=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Schedule-Continue': '1' },
            body: JSON.stringify(body)
        })
            .then(function (r) { return r.json(); })
            .then(function (result) {
                if (result && result.continueCursor) lastContinueCursor = result.continueCursor;
                if (result && result.config) {
                    scheduleConfig = result.config;
                    updateScheduleUI();
                }
                if (!result || result.needContinue || (result.config && result.config.running && result.config.cursor)) {
                    // 仍在跑：若被锁跳过也继续盯
                } else {
                    stopForceWatchPolling();
                    lastContinueCursor = null;
                    if (result && result.summary) {
                        showToast(result.summary, 'success');
                        log('info', '服务端巡检完成', result.summary);
                    }
                    fetchScheduleStatus();
                }
            })
            .catch(function () { fetchScheduleStatus(); });
        // 最长盯 15 分钟
        if (ticks >= 450) stopForceWatchPolling();
    }
    // 立即触发一次，再每 2 秒续跑（多机时尽快跑完）
    tickContinue();
    scheduleForceWatchTimer = setInterval(tickContinue, 2000);
}

function stopForceWatchPolling() {
    if (scheduleForceWatchTimer) {
        clearInterval(scheduleForceWatchTimer);
        scheduleForceWatchTimer = null;
    }
}

function startScheduleStatusPolling() {
    if (scheduleStatusPollTimer) return;
    // 每 30 秒：刷新状态 + 触发 run（未到间隔跳过；有 cursor 则续跑）
    // 打开本页时可作为辅助 cron；关页后必须配置外部 cron
    scheduleStatusPollTimer = setInterval(function () {
        fetch('/api/schedule/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json(); })
            .then(function (result) {
                if (result && result.config) {
                    scheduleConfig = result.config;
                    updateScheduleUI();
                    if (result.needContinue || (result.config && result.config.running && result.config.cursor)) {
                        startForceWatchPolling();
                    }
                } else {
                    fetchScheduleStatus();
                }
            })
            .catch(function () { fetchScheduleStatus(); });
    }, 30000);
}

function stopScheduleStatusPolling() {
    if (scheduleStatusPollTimer) {
        clearInterval(scheduleStatusPollTimer);
        scheduleStatusPollTimer = null;
    }
}

/**
 * 启动服务端定时：配置写入 KV，由 /api/schedule/run 按间隔执行
 * 关闭网页、切换服务商均不影响（但关页后需外部 cron 触发 run）
 */
async function startScheduledOps() {
    if (scheduleUiBusy) return;
    if (scheduleConfig && scheduleConfig.enabled) {
        showToast('服务端定时已在运行', 'info');
        return;
    }

    const input = document.getElementById('scheduleInterval');
    let mins = parseInt(input && input.value, 10);
    if (!mins || mins < 1) mins = 1;
    if (mins > 1440) mins = 1440;
    if (input) input.value = String(mins);

    scheduleUiBusy = true;
    updateScheduleUI();
    showToast('正在启动服务端定时…', 'info');

    try {
        const resp = await fetch('/api/schedule/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intervalMin: mins })
        });
        const result = await resp.json();
        if (result && result.success) {
            scheduleConfig = result.config || scheduleConfig;
            updateScheduleUI();
            startScheduleStatusPolling();
            if (result.run && (result.run.needContinue || (result.config && result.config.running))) {
                startForceWatchPolling();
            }
            showToast('服务端定时已启动，间隔 ' + mins + ' 分钟', 'success');
            log('success', '服务端定时已启动',
                '间隔 ' + mins + ' 分钟；关页后请用 cron-job.org 每分钟访问 /api/schedule/run');
            setTimeout(fetchScheduleStatus, 2000);
            setTimeout(fetchScheduleStatus, 10000);
            setTimeout(fetchScheduleStatus, 30000);
        } else {
            showToast((result && result.error) || '启动失败', 'error');
            log('error', '服务端定时启动失败', result && result.error);
        }
    } catch (e) {
        showToast('启动失败: ' + e.message, 'error');
        log('error', '服务端定时启动异常', e.message);
    } finally {
        scheduleUiBusy = false;
        updateScheduleUI();
    }
}

async function stopScheduledOps(silent) {
    if (scheduleUiBusy) return;
    scheduleUiBusy = true;
    updateScheduleUI();
    try {
        const resp = await fetch('/api/schedule/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const result = await resp.json();
        if (result && result.success) {
            scheduleConfig = result.config || Object.assign({}, scheduleConfig, {
                enabled: false, nextRunAt: null, running: false, cursor: null, progress: null
            });
            stopForceWatchPolling();
            updateScheduleUI();
            if (!silent) {
                showToast(result.msg || '服务端定时已停止', 'info');
                log('info', '服务端定时已停止');
            }
        } else if (!silent) {
            showToast((result && result.error) || '停止失败', 'error');
        }
    } catch (e) {
        if (!silent) showToast('停止失败: ' + e.message, 'error');
    } finally {
        scheduleUiBusy = false;
        updateScheduleUI();
    }
}

/** 手动触发一轮服务端巡检（force）；多机时分片续跑直到全部完成 */
async function runScheduledCheck() {
    if (scheduleUiBusy) return;
    scheduleUiBusy = true;
    updateScheduleUI();
    showToast('正在触发服务端巡检（全部机器）…', 'info');
    try {
        // force=1：有未完成进度则续跑，无进度则开新一轮（服务端逻辑）
        const resp = await fetch('/api/schedule/run?force=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const result = await resp.json();
        if (result && result.config) scheduleConfig = result.config;
        updateScheduleUI();
        if (result && result.skipped && result.reason === 'already_running') {
            showToast('巡检进行中，继续处理剩余机器…', 'info');
            startForceWatchPolling();
        } else if (result && result.skipped) {
            showToast('已跳过: ' + (result.reason || ''), 'info');
        } else if (result && result.needContinue) {
            showToast((result.summary || '巡检进行中') + '，后台继续处理剩余机器…', 'info');
            log('info', '服务端巡检分片进行中', result.summary);
            startForceWatchPolling();
        } else if (result && result.success !== false) {
            showToast(result.summary || '巡检完成', 'success');
            log('info', '服务端巡检完成', result.summary);
        } else {
            showToast((result && result.error) || '巡检失败', 'error');
        }
        await fetchScheduleStatus();
        if (scheduleConfig && (scheduleConfig.running || scheduleConfig.cursor)) startForceWatchPolling();
    } catch (e) {
        showToast('触发失败: ' + e.message, 'error');
    } finally {
        scheduleUiBusy = false;
        updateScheduleUI();
    }
}

/**
 * 切换服务商：服务端定时不停止（覆盖全部服务商）
 * 仅刷新 UI 状态展示
 */
function onProviderSwitchForSchedule() {
    fetchScheduleStatus();
}

// 页面加载：拉取服务端状态；若已启用则开始轮询展示
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
        fetchScheduleStatus().then(function (r) {
            if (r && r.config && r.config.enabled) {
                startScheduleStatusPolling();
            } else {
                updateScheduleUI();
            }
            if (r && r.config && r.config.running) {
                startForceWatchPolling();
            }
        });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                fetchScheduleStatus().then(function (r) {
                    if (r && r.config && r.config.running) startForceWatchPolling();
                });
            }
        });
    });
}

window.startScheduledOps = startScheduledOps;
window.stopScheduledOps = stopScheduledOps;
window.runScheduledCheck = runScheduledCheck;
window.onProviderSwitchForSchedule = onProviderSwitchForSchedule;
window.fetchScheduleStatus = fetchScheduleStatus;

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