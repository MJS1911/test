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