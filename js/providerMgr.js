/**
 * providerMgr.js - 服务商管理逻辑
 * 负责服务商的增删改查、活跃服务商切换、列表渲染
 *
 * 数据存储:
 * - provider_data_list: KV 中的服务商列表 JSON 数组
 * - active_provider_id: KV 中的当前活跃服务商 ID
 */

// ==================== 状态 ====================

let providers = [];
let activeProviderId = null;
let editingProviderId = null;

// ==================== DOM 引用 ====================

function $p(id) { return document.getElementById(id); }

// ==================== API 调用 ====================

/** 获取服务商列表 */
async function fetchProvidersAPI() {
    try {
        const resp = await fetch('/api/provider/list');
        const result = await resp.json();
        if (result.success) {
            providers = result.data || [];
            activeProviderId = result.activeId || null;
            return { success: true, providers, activeProviderId };
        }
        return { success: false, error: result.error || '获取服务商列表失败' };
    } catch (e) {
        return { success: false, error: '网络异常: ' + e.message };
    }
}

/** 保存服务商（新增或更新） */
async function saveProviderAPI(provider) {
    try {
        const resp = await fetch('/api/provider/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(provider)
        });
        return await resp.json();
    } catch (e) {
        return { success: false, error: '网络异常: ' + e.message };
    }
}

/** 删除服务商 */
async function deleteProviderAPI(providerId) {
    try {
        const resp = await fetch('/api/provider/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: providerId })
        });
        return await resp.json();
    } catch (e) {
        return { success: false, error: '网络异常: ' + e.message };
    }
}

/** 设置活跃服务商 */
async function setActiveProviderAPI(providerId) {
    try {
        const resp = await fetch('/api/provider/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: providerId })
        });
        return await resp.json();
    } catch (e) {
        return { success: false, error: '网络异常: ' + e.message };
    }
}

// ==================== 渲染 ====================

/** 生成简易 UUID */
function generateId() {
    return 'pv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

/** 加载并渲染服务商列表 */
async function loadProviders() {
    const result = await fetchProvidersAPI();
    if (result.success) {
        providers = result.providers;
        activeProviderId = result.activeProviderId;
        renderProviderList();
    } else {
        showToastAdmin(result.error || '加载服务商列表失败', 'error');
    }
}

/** 渲染左侧服务商列表 */
function renderProviderList() {
    const listEl = $p('providerList');
    if (!listEl) return;

    if (!providers || providers.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>暂无服务商配置</p></div>';
        return;
    }

    let html = '';
    providers.forEach(p => {
        const isActive = p.id === activeProviderId;
        const activeBadge = isActive ? ' <span class="badge badge-active">活跃</span>' : '';
        html += '<div class="provider-list-item ' + (isActive ? 'active' : '') + '" ' +
            'data-id="' + p.id + '" ' +
            'onclick="selectProvider(\'' + p.id + '\')">' +
            '<span class="provider-item-name">' + escapeHtmlAdmin(p.name || '未命名') + activeBadge + '</span>' +
            '<span class="provider-item-url">' + escapeHtmlAdmin(p.url || '') + '</span>' +
            '</div>';
    });
    listEl.innerHTML = html;
}

/** 选择服务商，显示详情 */
function selectProvider(providerId) {
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return;

    // 更新列表选中样式
    document.querySelectorAll('.provider-list-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === providerId);
    });

    // 显示详情面板
    const emptyPanel = $p('detailEmpty');
    const detailPanel = $p('detailPanel');
    const titleEl = $p('detailTitle');
    const detailEl = $p('providerDetail');

    if (emptyPanel) emptyPanel.style.display = 'none';
    if (detailPanel) detailPanel.style.display = 'block';
    if (titleEl) titleEl.textContent = provider.name || '服务商详情';

    const isActive = provider.id === activeProviderId;
    const btnActivate = $p('btnActivate');
    if (btnActivate) {
        btnActivate.textContent = isActive ? '✅ 已是活跃' : '✅ 设为活跃';
        btnActivate.className = isActive ? 'btn btn-sm btn-outline' : 'btn btn-sm btn-success';
        btnActivate.disabled = isActive;
    }

    if (detailEl) {
        detailEl.innerHTML =
            '<div class="detail-row"><span class="detail-label">名称</span><span class="detail-value">' + escapeHtmlAdmin(provider.name || '-') + '</span></div>' +
            '<div class="detail-row"><span class="detail-label">API 地址</span><span class="detail-value"><code>' + escapeHtmlAdmin(provider.url || '-') + '</code></span></div>' +
            '<div class="detail-row"><span class="detail-label">账号</span><span class="detail-value">' + escapeHtmlAdmin(provider.account || '-') + '</span></div>' +
            '<div class="detail-row"><span class="detail-label">API 密钥</span><span class="detail-value">' + (provider.apiKey ? '••••••••' : '-') + '</span></div>' +
            '<div class="detail-row"><span class="detail-label">备注</span><span class="detail-value">' + escapeHtmlAdmin(provider.notes || '-') + '</span></div>' +
            '<div class="detail-row"><span class="detail-label">状态</span><span class="detail-value">' + (isActive ? '<span class="badge badge-active">当前活跃</span>' : '<span class="badge">未激活</span>') + '</span></div>' +
            '<div class="detail-row"><span class="detail-label">创建时间</span><span class="detail-value">' + (provider.createdAt ? new Date(provider.createdAt * 1000).toLocaleString('zh-CN') : '-') + '</span></div>';
    }
}

// ==================== CRUD 操作 ====================

/** 打开新增服务商表单 */
function openProviderForm(providerId) {
    const overlay = $p('providerModalOverlay');
    const titleEl = $p('providerModalTitle');
    const msgEl = $p('providerFormMsg');
    if (!overlay) return;

    // 重置表单
    $p('providerName').value = '';
    $p('providerUrl').value = '';
    $p('providerAccount').value = '';
    $p('providerApiKey').value = '';
    $p('providerNotes').value = '';
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'login-msg'; }

    if (providerId) {
        // 编辑模式
        const provider = providers.find(p => p.id === providerId);
        if (provider) {
            editingProviderId = providerId;
            $p('providerName').value = provider.name || '';
            $p('providerUrl').value = provider.url || '';
            $p('providerAccount').value = provider.account || '';
            // API Key 不回显，留空表示不修改
            $p('providerApiKey').value = '';
            $p('providerApiKey').placeholder = '留空则不修改';
            $p('providerNotes').value = provider.notes || '';
            if (titleEl) titleEl.textContent = '编辑服务商';
        }
    } else {
        editingProviderId = null;
        if (titleEl) titleEl.textContent = '新增服务商';
        $p('providerApiKey').placeholder = 'API Key';
    }

    overlay.style.display = 'flex';
}

/** 关闭新增/编辑表单 */
function closeProviderForm() {
    const overlay = $p('providerModalOverlay');
    if (overlay) overlay.style.display = 'none';
    editingProviderId = null;
}

/** 保存服务商 */
async function saveProvider() {
    const name = $p('providerName').value.trim();
    const url = $p('providerUrl').value.trim();
    const account = $p('providerAccount').value.trim();
    const apiKey = $p('providerApiKey').value.trim();
    const notes = $p('providerNotes').value.trim();
    const msgEl = $p('providerFormMsg');
    const btnEl = $p('btnSaveProvider');

    if (!name) {
        if (msgEl) { msgEl.textContent = '请输入服务商名称'; msgEl.className = 'login-msg error'; }
        return;
    }
    if (!url) {
        if (msgEl) { msgEl.textContent = '请输入 API 地址'; msgEl.className = 'login-msg error'; }
        return;
    }

    const providerData = {
        id: editingProviderId || generateId(),
        name,
        url,
        account,
        apiKey,
        notes,
        createdAt: editingProviderId ? undefined : Math.floor(Date.now() / 1000)
    };

    // 如果是编辑且 apiKey 为空，不更新 apiKey（保留原值）
    if (editingProviderId && !apiKey) {
        const existing = providers.find(p => p.id === editingProviderId);
        if (existing) providerData.apiKey = existing.apiKey;
    }

    btnEl.disabled = true;
    if (msgEl) { msgEl.textContent = '正在保存...'; msgEl.className = 'login-msg'; }

    const result = await saveProviderAPI(providerData);
    if (result.success) {
        providers = result.data || [];
        activeProviderId = result.activeId || activeProviderId;
        renderProviderList();
        closeProviderForm();
        showToastAdmin(editingProviderId ? '服务商已更新' : '服务商已添加', 'success');
    } else {
        if (msgEl) { msgEl.textContent = '❌ ' + (result.error || '保存失败'); msgEl.className = 'login-msg error'; }
        showToastAdmin(result.error || '保存失败', 'error');
    }
    btnEl.disabled = false;
}

/** 编辑当前选中服务商 */
function editCurrentProvider() {
    // 找到当前选中的服务商
    const activeItem = document.querySelector('.provider-list-item.active');
    if (activeItem) {
        openProviderForm(activeItem.dataset.id);
    } else {
        showToastAdmin('请先在左侧选择一个服务商', 'warning');
    }
}

/** 删除当前选中服务商 */
async function deleteCurrentProvider() {
    const activeItem = document.querySelector('.provider-list-item.active');
    if (!activeItem) {
        showToastAdmin('请先在左侧选择一个服务商', 'warning');
        return;
    }

    const providerId = activeItem.dataset.id;
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return;

    if (!confirm('确定要删除服务商「' + provider.name + '」吗？\n此操作不可恢复。')) return;

    const result = await deleteProviderAPI(providerId);
    if (result.success) {
        providers = result.data || [];
        activeProviderId = result.activeId || activeProviderId;
        renderProviderList();
        // 隐藏详情
        const emptyPanel = $p('detailEmpty');
        const detailPanel = $p('detailPanel');
        if (emptyPanel) emptyPanel.style.display = 'block';
        if (detailPanel) detailPanel.style.display = 'none';
        showToastAdmin('服务商已删除', 'success');
    } else {
        showToastAdmin(result.error || '删除失败', 'error');
    }
}

/** 设置活跃服务商 */
async function activateProvider() {
    const activeItem = document.querySelector('.provider-list-item.active');
    if (!activeItem) {
        showToastAdmin('请先在左侧选择一个服务商', 'warning');
        return;
    }

    const providerId = activeItem.dataset.id;
    if (providerId === activeProviderId) {
        showToastAdmin('该服务商已是活跃状态', 'info');
        return;
    }

    const result = await setActiveProviderAPI(providerId);
    if (result.success) {
        providers = result.data || providers;
        activeProviderId = result.activeId || providerId;
        renderProviderList();
        selectProvider(providerId);
        showToastAdmin('已切换活跃服务商', 'success');
    } else {
        showToastAdmin(result.error || '切换失败', 'error');
    }
}

// 弹窗遮罩点击关闭
const pOverlay = $p('providerModalOverlay');
if (pOverlay) {
    pOverlay.addEventListener('click', function(e) {
        if (e.target === pOverlay) closeProviderForm();
    });
}

// 表单回车保存
document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && pOverlay && pOverlay.style.display === 'flex') {
        const formFields = ['providerName', 'providerUrl', 'providerAccount', 'providerApiKey', 'providerNotes'];
        const activeEl = document.activeElement;
        if (activeEl && formFields.includes(activeEl.id)) {
            e.preventDefault();
            saveProvider();
        }
    }
});