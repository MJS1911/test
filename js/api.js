/**
 * api.js - 魔方财务 API 客户端 (Cloudflare Pages 版本)
 * 负责 JWT 登录、服务器列表获取、状态查询、操作执行
 * 
 * 与 html/js/api.js 的区别:
 * - 删除了本地代理判断逻辑 (localhost/127.0.0.1 检测)
 * - 所有请求统一走 /api/* 路径，由 Cloudflare Functions 代理转发
 * - provisionUrl() 简化为 /api/provision/default
 * - 不再需要 useCookieAuth 参数，Functions 自动处理 Cookie 转换
 */

// ==================== 全局状态 ====================
const API = {
    baseUrl: '/api/',  // Cloudflare Pages 同源部署，固定为 /api/
    jwt: null,
    hosts: [],
    statusCache: {},  // { hostId: { status, des, ... } }
};

// 基础请求头
const BASE_HEADERS = {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.8,en;q=0.7',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
};

// ==================== 日志系统 ====================
function log(level, message, data) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = { timestamp, level, message, data };
    
    // 存储到全局日志数组
    if (!window.API_LOGS) window.API_LOGS = [];
    window.API_LOGS.push(logEntry);
    if (window.API_LOGS.length > 500) window.API_LOGS.shift();
    
    // 控制台输出
    const prefix = '[API ' + timestamp + ']';
    switch (level) {
        case 'error': console.error(prefix, message, data); break;
        case 'warning': console.warn(prefix, message, data); break;
        case 'success': console.log('%c' + prefix + ' ' + message, 'color: #22c55e', data); break;
        default: console.log(prefix, message, data);
    }
    
    // 触发 UI 更新事件
    window.dispatchEvent(new CustomEvent('api-log', { detail: logEntry }));
}

// ==================== 工具函数 ====================

/**
 * 构建完整 API URL
 * Cloudflare Pages 版本: 所有请求走 /api/* 路径，由 Functions 代理转发
 */
function apiUrl(path) {
    return '/api/' + path.replace(/^\/+/, '');
}

/**
 * 构建 provision URL
 * Cloudflare Pages 版本: 统一走 /api/provision/default
 * Functions 会自动处理 Cookie 认证和 Referer/Origin 设置
 */
function provisionUrl() {
    return '/api/provision/default';
}

/**
 * 发起 HTTP 请求
 * Cloudflare Pages 版本: 同源请求，无 CORS 问题
 * Functions 代理会自动处理 Cookie 转换和 Referer/Origin 设置
 */
async function apiRequest(url, options = {}) {
    const { method = 'GET', headers = {}, body = null } = options;

    const finalHeaders = { ...BASE_HEADERS, ...headers };

    // 如果有 JWT，添加 Authorization 头
    // Cloudflare Functions 会自动从中提取 JWT 并设置为 Cookie
    if (API.jwt) {
        finalHeaders['Authorization'] = 'Bearer ' + API.jwt;
    }

    const fetchOptions = {
        method,
        headers: finalHeaders,
        credentials: 'include',  // 携带 cookie
    };

    if (body) {
        fetchOptions.body = body;
    }

    log('debug', '请求: ' + method + ' ' + url, body ? 'Body: ' + body : null);

    try {
        const resp = await fetch(url, fetchOptions);

        log('debug', '响应状态: ' + resp.status + ' ' + resp.statusText);

        // 尝试解析 JSON
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const json = await resp.json();
            log('debug', '响应 JSON: ' + JSON.stringify(json).substring(0, 500));
            return json;
        }

        // 非 JSON 响应，返回文本
        const text = await resp.text();
        log('debug', '响应文本: ' + text.substring(0, 500));
        try {
            return JSON.parse(text);
        } catch {
            return { status: resp.status, raw: text };
        }
    } catch (err) {
        log('error', '请求失败: ' + err.message, 'URL: ' + url);
        throw new Error('网络请求失败: ' + err.message);
    }
}

// ==================== 登录 ====================

/**
 * 使用账号和 API 密钥登录，获取 JWT Token
 */
async function loginAPI(account, apiKey) {
    const url = apiUrl('login_api');

    const params = new URLSearchParams();
    params.append('account', account);
    params.append('password', apiKey);

    log('info', '登录请求', 'account=' + account);
    const result = await apiRequest(url, {
        method: 'POST',
        body: params.toString(),
    });

    if (result.status === 200 && result.jwt) {
        API.jwt = result.jwt;
        log('success', '登录成功', 'JWT: ' + result.jwt.substring(0, 20) + '...');
        return { success: true, jwt: result.jwt };
    }

    const msg = result.msg || result.info || '登录失败，请检查账号和API密钥';
    log('error', '登录失败', msg);
    return { success: false, error: msg };
}

// ==================== 服务器列表 ====================

/**
 * 获取账号下所有服务器
 */
async function fetchHosts(page = 1, limit = 200) {
    if (!API.jwt) {
        throw new Error('未登录，请先登录');
    }

    const url = apiUrl('hosts') + '?page=' + page + '&limit=' + limit;

    log('info', '获取服务器列表', 'page=' + page + ' limit=' + limit);
    const result = await apiRequest(url, {
        method: 'GET',
    });

    if (result.status === 200) {
        const data = result.data || {};
        const hosts = data.host || [];
        API.hosts = hosts;
        log('success', '获取服务器列表成功', '共 ' + hosts.length + ' 台');
        return { success: true, hosts, total: data.total || hosts.length };
    }

    const msg = result.msg || '获取服务器列表失败';
    log('error', '获取服务器列表失败', msg);
    return { success: false, error: msg };
}

// ==================== 服务器状态 ====================

/**
 * 查询单个服务器状态
 * @param {number|string} hostId - 服务器 ID
 */
async function fetchServerStatus(hostId) {
    if (!API.jwt) {
        throw new Error('未登录');
    }

    const url = provisionUrl();

    const params = new URLSearchParams();
    params.append('id', String(hostId));
    params.append('func', 'status');

    const result = await apiRequest(url, {
        method: 'POST',
        body: params.toString(),
    });

    if (result.status === 200) {
        const data = result.data || {};
        API.statusCache[hostId] = data;
        log('success', '查询状态成功 #' + hostId, data);
        return { success: true, data };
    }

    const msg = result.msg || '查询状态失败';
    log('error', '查询状态失败 #' + hostId, msg);
    return { success: false, error: msg };
}

/**
 * 批量查询所有服务器状态
 */
async function fetchAllStatuses(onProgress) {
    const results = {};
    let completed = 0;
    const total = API.hosts.length;

    for (const host of API.hosts) {
        const hostId = host.id;
        try {
            const r = await fetchServerStatus(hostId);
            results[hostId] = r.success ? r.data : { status: 'error', des: r.error };
        } catch (e) {
            results[hostId] = { status: 'error', des: e.message };
        }
        completed++;
        if (onProgress) {
            onProgress(completed, total, hostId, results[hostId]);
        }
    }

    return results;
}

// ==================== 服务器操作 ====================

/**
 * 操作映射表
 */
const OPERATION_MAP = {
    'on':           { func: 'on',           label: '开机',     method: 'PUT' },
    'off':          { func: 'off',          label: '关机',     method: 'PUT' },
    'reboot':       { func: 'reboot',       label: '重启',     method: 'PUT' },
    'hard_reboot':  { func: 'hard_reboot',  label: '硬重启',   method: 'PUT' },
    'hard_off':     { func: 'hard_off',     label: '硬关机',   method: 'PUT' },
};

/**
 * 对指定服务器执行操作
 * @param {number|string} hostId - 服务器 ID
 * @param {string} operation - 操作类型: on/off/reboot/hard_reboot/hard_off
 */
async function performOperation(hostId, operation) {
    if (!API.jwt) {
        throw new Error('未登录');
    }

    const opInfo = OPERATION_MAP[operation];
    if (!opInfo) {
        throw new Error('不支持的操作: ' + operation);
    }

    const url = provisionUrl();

    const params = new URLSearchParams();
    params.append('id', String(hostId));
    params.append('func', opInfo.func);

    log('info', '执行操作: ' + opInfo.label + ' #' + hostId, 'func=' + opInfo.func);

    const result = await apiRequest(url, {
        method: 'POST',
        body: params.toString(),
    });

    if (result.status === 200) {
        // 检查是否需要二次验证
        if (result.data && result.data._second_verify) {
            log('warning', '需要二次验证 #' + hostId, result.data._second_verify);
            return {
                success: true,
                needVerify: true,
                verifyData: result.data._second_verify,
                msg: '需要二次验证',
            };
        }
        log('success', opInfo.label + '操作成功 #' + hostId, result.msg);
        return { success: true, msg: result.msg || opInfo.label + '操作成功' };
    }

    const msg = result.msg || result.info || opInfo.label + '操作失败';
    log('error', opInfo.label + '操作失败 #' + hostId, msg);
    return { success: false, error: msg };
}

/**
 * 获取主机支持的 server 模块接口列表
 */
async function fetchServerModules(hostId) {
    if (!API.jwt) {
        throw new Error('未登录');
    }

    const url = apiUrl('hosts/' + hostId + '/module');

    const result = await apiRequest(url, {
        method: 'GET',
    });

    if (result.status === 200) {
        return { success: true, modules: result.data || result };
    }

    return { success: false, error: result.msg || '获取模块列表失败' };
}

// ==================== KV 认证存储 ====================

/**
 * 保存登录凭证到 Cloudflare KV
 * 登录成功后自动调用，下次打开页面自动填充
 */
async function saveAuth(account, apiKey, baseUrl) {
    try {
        const resp = await fetch('/api/auth/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account, apiKey, baseUrl })
        });
        const result = await resp.json();
        if (result.success) {
            log('success', '凭证已保存到云端', 'account=' + account);
        } else {
            log('warning', '凭证保存失败: ' + (result.error || '未知错误'));
        }
        return result;
    } catch (e) {
        log('warning', '凭证保存异常: ' + e.message + ' (可能 KV 未配置，不影响使用)');
        return { success: false, error: e.message };
    }
}

/**
 * 从 Cloudflare KV 读取登录凭证
 * 页面加载时自动调用，填充表单
 */
async function loadAuth() {
    try {
        const resp = await fetch('/api/auth/load');
        const result = await resp.json();
        if (result.success && result.data) {
            log('info', '从云端加载凭证成功', 'account=' + result.data.account);
            return result.data;
        }
        log('debug', '云端无保存的凭证');
        return null;
    } catch (e) {
        log('debug', '凭证加载异常: ' + e.message + ' (可能 KV 未配置)');
        return null;
    }
}

/**
 * 清除 Cloudflare KV 中的登录凭证
 * 登出时自动调用
 */
async function clearAuth() {
    try {
        const resp = await fetch('/api/auth/clear', { method: 'POST' });
        const result = await resp.json();
        if (result.success) {
            log('info', '云端凭证已清除');
        }
        return result;
    } catch (e) {
        log('debug', '凭证清除异常: ' + e.message);
        return { success: false, error: e.message };
    }
}

// ==================== 管理密码验证 ====================

/**
 * 验证管理密码
 * @param {string} password - 管理密码
 */
async function verifyAdminPasswordAPI(password) {
    try {
        const resp = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const result = await resp.json();
        return result;
    } catch (e) {
        log('error', '管理密码验证异常: ' + e.message);
        return { success: false, error: '网络异常: ' + e.message };
    }
}

/**
 * 修改管理密码
 * @param {string} oldPassword - 原密码
 * @param {string} newPassword - 新密码
 */
async function changeAdminPasswordAPI(oldPassword, newPassword) {
    try {
        const resp = await fetch('/api/admin/change', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        const result = await resp.json();
        return result;
    } catch (e) {
        log('error', '修改管理密码异常: ' + e.message);
        return { success: false, error: '网络异常: ' + e.message };
    }
}

/**
 * 检查是否已验证管理密码
 */
async function checkAdminVerified() {
    try {
        const resp = await fetch('/api/admin/check');
        const result = await resp.json();
        return result.verified || false;
    } catch (e) {
        return false;
    }
}