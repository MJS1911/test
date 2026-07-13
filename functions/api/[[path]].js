/**
 * Cloudflare Pages Function - API 代理 + 认证存储
 * 替代本地 proxy.js，部署到 Cloudflare Pages Functions 后自动生效
 * 路由: /api/* -> 代理到目标魔方财务 API
 * 路由: /api/auth/save -> 保存登录凭证到 KV
 * 路由: /api/auth/load -> 从 KV 读取登录凭证
 * 路由: /api/auth/clear -> 清除 KV 中的登录凭证
 * 路由: /api/admin/check_init -> 检查站点管理员密码是否已初始化
 * 路由: /api/admin/init -> 初始化站点管理员密码
 * 路由: /api/admin/verify -> 验证站点管理员密码（登录）
 * 路由: /api/admin/change -> 修改站点管理员密码
 * 路由: /api/admin/check -> 检查是否已验证管理密码
 * 路由: /api/provider/list -> 获取服务商列表
 * 路由: /api/provider/save -> 保存（新增/编辑）服务商
 * 路由: /api/provider/delete -> 删除服务商
 * 路由: /api/provider/active -> 设置活跃服务商
 * 路由: /api/provider/auto-login -> 自动登录服务商（服务端代理登录获取 JWT）
 * 路由: /api/schedule/status -> 获取服务端定时任务状态
 * 路由: /api/schedule/start  -> 启动服务端定时（KV 持久化，关网页不停）
 * 路由: /api/schedule/stop   -> 停止服务端定时
 * 路由: /api/schedule/run    -> 执行一轮巡检（Cron/外部定时器调用；未到期则跳过）
 * 路由: /api/schedule/logs   -> 最近执行日志
 * 
 * 部署后可用地址: https://<your-project>.pages.dev/api/*
 * 
 * 关键功能:
 * 1. 转发所有 /api/* 请求到目标 API 域名
 * 2. 自动处理 CORS (添加 Access-Control-Allow-Origin 等头)
 * 3. 从 Authorization: Bearer <jwt> 头提取 JWT，设置为 Cookie: ZJMF_8F073A284ADDCA6A=<jwt>
 *    这是魔方财务 provision 接口要求的 Cookie 认证方式
 * 4. 透传 Origin、Referer 等头部，满足魔方财务的 Referer/Origin 校验
 * 5. /api/auth/* 端点使用 KV 存储登录凭证，实现持久化登录
 * 
 * 部署前需要在 Cloudflare Pages 设置中绑定 KV namespace:
 * 变量名: AUTH_KV
 */

export async function onRequest(context) {
  const { request, env } = context;
  
  // ========== /api/auth/* 路由：KV 存储认证凭证 ==========
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  
  // 认证存储端点，不转发到目标 API
  if (path === '/auth/save' || path === '/auth/save/') {
    return handleAuthSave(context);
  }
  if (path === '/auth/load' || path === '/auth/load/') {
    return handleAuthLoad(context);
  }
  if (path === '/auth/clear' || path === '/auth/clear/') {
    return handleAuthClear(context);
  }
  
  // ========== /api/admin/* 路由：站点管理员密码管理 ==========
  if (path === '/admin/check_init' || path === '/admin/check_init/') {
    return handleAdminCheckInit(context);
  }
  if (path === '/admin/init' || path === '/admin/init/') {
    return handleAdminInit(context);
  }
  if (path === '/admin/verify' || path === '/admin/verify/') {
    return handleAdminVerify(context);
  }
  if (path === '/admin/change' || path === '/admin/change/') {
    return handleAdminChange(context);
  }
  if (path === '/admin/check' || path === '/admin/check/') {
    return handleAdminCheck(context);
  }
  
  // ========== /api/provider/* 路由：服务商管理 ==========
  if (path === '/provider/list' || path === '/provider/list/') {
    return handleProviderList(context);
  }
  if (path === '/provider/save' || path === '/provider/save/') {
    return handleProviderSave(context);
  }
  if (path === '/provider/delete' || path === '/provider/delete/') {
    return handleProviderDelete(context);
  }
  if (path === '/provider/active' || path === '/provider/active/') {
    return handleProviderActive(context);
  }
  if (path === '/provider/auto-login' || path === '/provider/auto-login/') {
    return handleProviderAutoLogin(context);
  }

  // ========== /api/schedule/* 路由：服务端长效定时巡检 ==========
  if (path === '/schedule/status' || path === '/schedule/status/') {
    return handleScheduleStatus(context);
  }
  if (path === '/schedule/start' || path === '/schedule/start/') {
    return handleScheduleStart(context);
  }
  if (path === '/schedule/stop' || path === '/schedule/stop/') {
    return handleScheduleStop(context);
  }
  if (path === '/schedule/run' || path === '/schedule/run/') {
    return handleScheduleRun(context);
  }
  if (path === '/schedule/logs' || path === '/schedule/logs/') {
    return handleScheduleLogs(context);
  }
  
  // ========== 常规 API 代理转发 ==========
  // 多平台支持：优先级顺序
  // 1. 请求头 X-Target-Base（登录时前端传入，首次登录 KV 为空时使用）
  // 2. KV 存储的用户配置（登录成功后保存，后续请求使用）
  // 3. 环境变量 API_BASE_URL（Cloudflare Pages 设置）
  // 4. 默认值
  let targetApiBase = env.API_BASE_URL || 'https://www.heyunidc.cn/v1/';
  let provisionApiBase = 'https://www.heyunidc.cn/';

  // 优先读取请求头中的目标平台地址（登录时前端传入）
  const targetBaseHeader = request.headers.get('X-Target-Base');
  if (targetBaseHeader) {
    targetApiBase = targetBaseHeader;
    try {
      const parsed = new URL(targetBaseHeader);
      provisionApiBase = parsed.origin + '/';
    } catch (e) {
      console.warn('X-Target-Base 格式无效:', targetBaseHeader);
    }
  }
  
  // 其次从 KV 读取（登录成功后保存的配置）
  if (!targetBaseHeader && env.AUTH_KV) {
    try {
      const authRaw = await env.AUTH_KV.get('auth_credentials');
      if (authRaw) {
        const authData = JSON.parse(authRaw);
        if (authData.baseUrl) {
          targetApiBase = authData.baseUrl;
          const parsed = new URL(authData.baseUrl);
          provisionApiBase = parsed.origin + '/';
        }
      }
    } catch (e) {
      console.warn('读取 KV 配置失败，使用默认值:', e);
    }
  }

  // 获取请求路径，去掉 /api 前缀 (url 已在上面声明)
  const search = url.search;

  // 构建目标 URL
  // 注意：targetApiBase 以 /v1/ 结尾，path 是 /login_api 这样的绝对路径
  // new URL('/login_api', 'https://xxx/v1/') 会变成 https://xxx/login_api（丢失 /v1/）
  // 所以需要去掉 path 开头的 /，让它变成相对路径拼接
  const relativePath = path.replace(/^\//, '');
  
  // provision 接口使用根域名，其他接口使用 /v1/
  const isProvision = relativePath.startsWith('provision/');
  const targetBase = isProvision ? provisionApiBase : targetApiBase;
  const targetUrl = new URL(relativePath + search, targetBase);

  // 复制请求头
  const headers = new Headers(request.headers);

  // 移除可能导致问题的头部
  headers.delete('host');
  headers.delete('content-length');

  // 关键：从 Authorization: Bearer <jwt> 提取 JWT，设置为 Cookie
  // 魔方财务 provision 接口要求 Cookie: ZJMF_8F073A284ADDCA6A=<jwt>
  const authHeader = headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const jwt = authHeader.substring(7);
    headers.set('Cookie', `ZJMF_8F073A284ADDCA6A=${jwt}`);
  }

  // 设置 Origin 和 Referer 为目标域名，满足魔方财务的 Referer/Origin 校验
  const targetOrigin = new URL(targetBase).origin;
  headers.set('Origin', targetOrigin);
  headers.set('Referer', targetOrigin + '/');

  // 设置 User-Agent 模拟浏览器
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('Accept', '*/*');
  headers.set('Accept-Language', 'zh-CN,zh;q=0.8,en;q=0.7');

  // 构建转发请求
  const proxyRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'follow',
  });

  try {
    // 发起请求到目标 API
    const response = await fetch(proxyRequest);

    // 创建响应头，添加 CORS 头
    const responseHeaders = new Headers(response.headers);

    // 关键：添加 CORS 头，允许前端跨域访问
    const origin = request.headers.get('Origin') || '*';
    responseHeaders.set('Access-Control-Allow-Origin', origin);
    responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin, Referer, Accept, Accept-Language, Cookie');
    responseHeaders.set('Access-Control-Expose-Headers', 'Set-Cookie');

    // 移除可能导致问题的头部
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('x-frame-options');

    // 返回响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(JSON.stringify({ 
      error: 'Proxy error', 
      message: error.message 
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
      },
    });
  }
}

// ==================== KV 认证存储处理函数 ====================

/**
 * 保存登录凭证到 KV
 */
async function handleAuthSave(context) {
  const { request, env } = context;
  
  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'KV 存储未配置，请在 Cloudflare Pages 设置中绑定 KV namespace' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { account, apiKey, baseUrl } = body;

    if (!account || !apiKey) {
      return new Response(JSON.stringify({ success: false, error: '账号和API密钥不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const data = {
      account,
      apiKey,
      baseUrl: baseUrl || '',
      updatedAt: new Date().toISOString()
    };

    await env.AUTH_KV.put('auth_credentials', JSON.stringify(data));

    return new Response(JSON.stringify({ success: true, msg: '凭证已保存' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 读取登录凭证
 */
async function handleAuthLoad(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const raw = await env.AUTH_KV.get('auth_credentials');
    
    if (!raw) {
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const data = JSON.parse(raw);
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 清除登录凭证
 */
async function handleAuthClear(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    await env.AUTH_KV.delete('auth_credentials');
    return new Response(JSON.stringify({ success: true, msg: '凭证已清除' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// ==================== 站点管理员密码管理（KV Key: site_admin_pwd） ====================

/**
 * 获取站点管理员密码（从 KV 读取，不存在返回 null）
 */
async function getSiteAdminPassword(env) {
  if (!env.AUTH_KV) return null;
  try {
    return await env.AUTH_KV.get('site_admin_pwd');
  } catch {
    return null;
  }
}

/**
 * 设置站点管理员密码（存储到 KV）
 */
async function setSiteAdminPassword(env, password) {
  if (!env.AUTH_KV) throw new Error('KV 存储未配置');
  await env.AUTH_KV.put('site_admin_pwd', password);
}

/**
 * 检查站点管理员密码是否已初始化
 */
async function handleAdminCheckInit(context) {
  const { env } = context;

  try {
    const pwd = await getSiteAdminPassword(env);
    return new Response(JSON.stringify({ success: true, initialized: !!pwd }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 初始化站点管理员密码（仅首次设置）
 */
async function handleAdminInit(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { password } = body;

    if (!password || password.length < 6) {
      return new Response(JSON.stringify({ success: false, error: '密码长度至少 6 位' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 检查是否已初始化
    const existing = await getSiteAdminPassword(env);
    if (existing) {
      return new Response(JSON.stringify({ success: false, error: '管理员密码已设置，无需重复初始化' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    await setSiteAdminPassword(env, password);
    return new Response(JSON.stringify({ success: true, msg: '管理员密码设置成功' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 验证站点管理员密码（登录）
 */
async function handleAdminVerify(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { password } = body;

    if (!password) {
      return new Response(JSON.stringify({ success: false, error: '请输入管理密码' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const storedPassword = await getSiteAdminPassword(env);
    if (!storedPassword) {
      return new Response(JSON.stringify({ success: false, error: '管理员密码未设置，请先初始化' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const isValid = password === storedPassword;
    return new Response(JSON.stringify({ success: isValid, error: isValid ? null : '管理密码错误' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 修改站点管理员密码
 */
async function handleAdminChange(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { oldPassword, newPassword } = body;

    if (!oldPassword || !newPassword) {
      return new Response(JSON.stringify({ success: false, error: '旧密码和新密码不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (newPassword.length < 6) {
      return new Response(JSON.stringify({ success: false, error: '新密码长度至少 6 位' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const storedPassword = await getSiteAdminPassword(env);
    if (!storedPassword) {
      return new Response(JSON.stringify({ success: false, error: '管理员密码未设置' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (oldPassword !== storedPassword) {
      return new Response(JSON.stringify({ success: false, error: '原密码错误' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    await setSiteAdminPassword(env, newPassword);
    return new Response(JSON.stringify({ success: true, msg: '密码修改成功，请使用新密码重新登录' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 检查是否已验证管理密码（通过 Cookie 或 Session）
 */
async function handleAdminCheck(context) {
  const { request } = context;

  // 从 Cookie 中读取 admin_verified 标记
  const cookieHeader = request.headers.get('Cookie') || '';
  const verified = cookieHeader.includes('admin_verified=true');

  return new Response(JSON.stringify({ success: true, verified }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ==================== 服务商管理（KV Key: provider_data_list / active_provider_id） ====================

/**
 * 获取全部服务商数据
 */
async function getProviders(env) {
  if (!env.AUTH_KV) return [];
  try {
    const raw = await env.AUTH_KV.get('provider_data_list');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * 保存全部服务商数据
 */
async function saveProviders(env, providers) {
  if (!env.AUTH_KV) throw new Error('KV 存储未配置');
  await env.AUTH_KV.put('provider_data_list', JSON.stringify(providers));
}

/**
 * 获取活跃服务商 ID
 */
async function getActiveProviderId(env) {
  if (!env.AUTH_KV) return null;
  try {
    return await env.AUTH_KV.get('active_provider_id');
  } catch {
    return null;
  }
}

/**
 * 设置活跃服务商 ID
 */
async function setActiveProviderId(env, providerId) {
  if (!env.AUTH_KV) throw new Error('KV 存储未配置');
  await env.AUTH_KV.put('active_provider_id', providerId);
}

/**
 * 获取服务商列表
 */
async function handleProviderList(context) {
  const { env } = context;

  try {
    const providers = await getProviders(env);
    const activeId = await getActiveProviderId(env);
    return new Response(JSON.stringify({ success: true, data: providers, activeId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 保存服务商（新增或编辑）
 */
async function handleProviderSave(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { id, name, url, account, apiKey, notes, createdAt } = body;

    if (!id || !name || !url) {
      return new Response(JSON.stringify({ success: false, error: '缺少必填字段 (id/name/url)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const providers = await getProviders(env);
    const existingIndex = providers.findIndex(p => p.id === id);

    const providerData = {
      id,
      name,
      url,
      account: account || '',
      apiKey: apiKey || '',
      notes: notes || '',
      createdAt: createdAt || Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000)
    };

    if (existingIndex >= 0) {
      // 编辑模式：保留原有 createdAt
      providerData.createdAt = providers[existingIndex].createdAt;
      providers[existingIndex] = providerData;
    } else {
      // 新增模式
      providers.push(providerData);
      // 如果是第一个服务商，自动设为活跃
      if (providers.length === 1) {
        await setActiveProviderId(env, id);
      }
    }

    await saveProviders(env, providers);
    const activeId = await getActiveProviderId(env);

    return new Response(JSON.stringify({ success: true, data: providers, activeId, msg: existingIndex >= 0 ? '服务商已更新' : '服务商已添加' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 删除服务商
 */
async function handleProviderDelete(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return new Response(JSON.stringify({ success: false, error: '缺少服务商 ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let providers = await getProviders(env);
    providers = providers.filter(p => p.id !== id);

    // 如果删除的是活跃服务商，清除活跃标记
    const activeId = await getActiveProviderId(env);
    let newActiveId = activeId;
    if (activeId === id) {
      newActiveId = providers.length > 0 ? providers[0].id : null;
      if (newActiveId) {
        await setActiveProviderId(env, newActiveId);
      } else {
        await env.AUTH_KV.delete('active_provider_id');
      }
    }

    await saveProviders(env, providers);

    return new Response(JSON.stringify({ success: true, data: providers, activeId: newActiveId, msg: '服务商已删除' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 设置活跃服务商
 */
async function handleProviderActive(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return new Response(JSON.stringify({ success: false, error: '缺少服务商 ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 验证服务商存在
    const providers = await getProviders(env);
    const provider = providers.find(p => p.id === id);
    if (!provider) {
      return new Response(JSON.stringify({ success: false, error: '服务商不存在' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    await setActiveProviderId(env, id);

    return new Response(JSON.stringify({ success: true, data: providers, activeId: id, msg: '已切换活跃服务商' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

/**
 * 自动登录服务商（服务端代理登录获取 JWT）
 * POST /api/provider/auto-login
 * Body: { id: "provider_id" }
 * 响应: { success: true, jwt: "..." }
 */
async function handleProviderAutoLogin(context) {
  const { request, env } = context;

  if (!env.AUTH_KV) {
    return new Response(JSON.stringify({ success: false, error: 'KV 存储未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return new Response(JSON.stringify({ success: false, error: '缺少服务商 ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 查找服务商
    const providers = await getProviders(env);
    const provider = providers.find(p => p.id === id);
    if (!provider) {
      return new Response(JSON.stringify({ success: false, error: '服务商不存在' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (!provider.account || !provider.apiKey) {
      return new Response(JSON.stringify({ success: false, error: '服务商缺少登录凭证（账号/API密钥）' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 构建目标登录 URL
    // provider.url 格式: https://xxx.com/v1/ 或 https://xxx.com/
    let baseUrl = provider.url;
    if (!baseUrl.endsWith('/')) baseUrl += '/';
    const loginUrl = new URL('login_api', baseUrl).toString();

    console.log('auto-login: 尝试登录服务商', provider.name, 'at', loginUrl);

    // 构建登录请求体 (application/x-www-form-urlencoded)
    const formBody = new URLSearchParams();
    formBody.append('account', provider.account);
    formBody.append('password', provider.apiKey);

    // 设置请求头（模拟魔方财务前端请求）
    const headers = new Headers();
    headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
    headers.set('Accept', '*/*');
    headers.set('Accept-Language', 'zh-CN,zh;q=0.8,en;q=0.7');
    headers.set('X-Requested-With', 'XMLHttpRequest');
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 设置 Origin 和 Referer
    const targetOrigin = new URL(baseUrl).origin;
    headers.set('Origin', targetOrigin);
    headers.set('Referer', targetOrigin + '/');

    const loginReq = new Request(loginUrl, {
      method: 'POST',
      headers: headers,
      body: formBody.toString(),
      redirect: 'follow',
    });

    const loginResp = await fetch(loginReq);
    const loginData = await loginResp.json();

    console.log('auto-login: 登录响应状态', loginResp.status, 'data keys:', Object.keys(loginData));

    // 魔方财务 login_api 返回格式: { status: 200, info: { jwt: "..." } }
    // 也可能是简化格式: { status: 200, jwt: "..." }
    let jwt = null;
    if (loginData.status === 200) {
      // 优先从 info.jwt 提取
      if (loginData.info && loginData.info.jwt) {
        jwt = loginData.info.jwt;
      } else if (loginData.jwt) {
        jwt = loginData.jwt;
      } else if (loginData.data && loginData.data.jwt) {
        jwt = loginData.data.jwt;
      }
    }

    if (jwt) {
      // 同时保存当前服务商的 baseUrl 到 KV，确保后续 API 代理能正确路由
      try {
        const authData = {
          account: provider.account,
          apiKey: provider.apiKey,
          baseUrl: provider.url,
          updatedAt: new Date().toISOString()
        };
        await env.AUTH_KV.put('auth_credentials', JSON.stringify(authData));
      } catch (kvErr) {
        console.warn('auto-login: KV 保存失败（不影响登录）:', kvErr);
      }

      return new Response(JSON.stringify({ success: true, jwt }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } else {
      const errMsg = loginData.msg || loginData.info?.msg || loginData.message || '登录失败，未获取到 JWT';
      console.error('auto-login: 登录失败', loginData);
      return new Response(JSON.stringify({ success: false, error: errMsg }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  } catch (error) {
    console.error('auto-login error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// ==================== 服务端定时巡检（KV 持久化，关网页不停） ====================
// KV keys:
//   schedule_config  - { enabled, intervalMin, lastRunAt, nextRunAt, running, lastSummary,
//                        stats, cursor, progress, updatedAt }
//   schedule_logs    - [{ ts, level, msg, detail? }, ...] 最多 150 条
//
// 关页后必须有「触发器」周期性访问 /api/schedule/run（Pages 无常驻进程）：
// 1. 外部 cron（cron-job.org / UptimeRobot）每 1 分钟 GET/POST 你的站点 /api/schedule/run
// 2. 打开本页时前端每分钟也会辅助触发
// 3. 手动「立即巡检」= force 全量跑完（分片续跑直到全部机器处理完）
//
// 分片续跑：单次 Function 有 CPU/时长上限，多机时按时间片处理，未完成则 waitUntil
// 自调用 /api/schedule/run?continue=1 继续，保证每一台都会查状态并恢复。

const SCHEDULE_CONFIG_KEY = 'schedule_config';
const SCHEDULE_LOGS_KEY = 'schedule_logs';
const SCHEDULE_MAX_LOGS = 150;
const SCHEDULE_DEFAULT_INTERVAL = 5;
const SCHEDULE_MIN_INTERVAL = 1;
const SCHEDULE_MAX_INTERVAL = 1440;
/** 单次调用时间预算(ms)，留余量给收尾与自续跑，避免 CF 硬超时只处理 1 台 */
const SCHEDULE_TIME_BUDGET_MS = 22000;
/** 卡住 running 超过此时长则强制解锁续跑 */
const SCHEDULE_STALE_MS = 90 * 1000;
/** 主机间最小间隔，避免打爆目标站 */
const SCHEDULE_HOST_GAP_MS = 80;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function defaultScheduleConfig() {
  return {
    enabled: false,
    intervalMin: SCHEDULE_DEFAULT_INTERVAL,
    lastRunAt: null,
    nextRunAt: null,
    running: false,
    lastSummary: null,
    stats: null,
    cursor: null,
    progress: null,
    updatedAt: null
  };
}

function defaultRoundStats() {
  return { checked: 0, running: 0, recovered: 0, failed: 0 };
}

async function getScheduleConfig(env) {
  if (!env.AUTH_KV) return defaultScheduleConfig();
  try {
    const raw = await env.AUTH_KV.get(SCHEDULE_CONFIG_KEY);
    if (!raw) return defaultScheduleConfig();
    return Object.assign(defaultScheduleConfig(), JSON.parse(raw));
  } catch {
    return defaultScheduleConfig();
  }
}

async function saveScheduleConfig(env, cfg) {
  if (!env.AUTH_KV) throw new Error('KV 存储未配置');
  cfg.updatedAt = new Date().toISOString();
  await env.AUTH_KV.put(SCHEDULE_CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

async function getScheduleLogs(env) {
  if (!env.AUTH_KV) return [];
  try {
    const raw = await env.AUTH_KV.get(SCHEDULE_LOGS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 批量追加日志（减少 KV 读写，避免超时） */
async function appendScheduleLogsBatch(env, entries) {
  if (!env.AUTH_KV || !entries || !entries.length) return;
  try {
    const logs = await getScheduleLogs(env);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      logs.unshift({
        ts: e.ts || new Date().toISOString(),
        level: e.level || 'info',
        msg: String(e.msg || ''),
        detail: e.detail != null ? String(e.detail).substring(0, 500) : undefined
      });
    }
    while (logs.length > SCHEDULE_MAX_LOGS) logs.pop();
    await env.AUTH_KV.put(SCHEDULE_LOGS_KEY, JSON.stringify(logs));
  } catch (e) {
    console.warn('appendScheduleLogsBatch failed:', e);
  }
}

async function appendScheduleLog(env, level, msg, detail) {
  await appendScheduleLogsBatch(env, [{ level, msg, detail }]);
}

function createLogBuffer() {
  const buf = [];
  return {
    push(level, msg, detail) {
      buf.push({ ts: new Date().toISOString(), level, msg, detail });
    },
    async flush(env) {
      if (!buf.length) return;
      const copy = buf.splice(0, buf.length);
      await appendScheduleLogsBatch(env, copy);
    }
  };
}

/** 服务端登录服务商，返回 jwt 或 null */
async function serverLoginProvider(provider) {
  if (!provider || !provider.account || !provider.apiKey || !provider.url) {
    return { ok: false, error: '服务商缺少凭证或 URL' };
  }
  let baseUrl = provider.url;
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  const loginUrl = new URL('login_api', baseUrl).toString();

  const formBody = new URLSearchParams();
  formBody.append('account', provider.account);
  formBody.append('password', provider.apiKey);

  const headers = new Headers();
  headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
  headers.set('Accept', '*/*');
  headers.set('Accept-Language', 'zh-CN,zh;q=0.8,en;q=0.7');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  const targetOrigin = new URL(baseUrl).origin;
  headers.set('Origin', targetOrigin);
  headers.set('Referer', targetOrigin + '/');

  const loginResp = await fetch(loginUrl, {
    method: 'POST',
    headers,
    body: formBody.toString(),
    redirect: 'follow'
  });
  let loginData;
  try {
    loginData = await loginResp.json();
  } catch (e) {
    return { ok: false, error: '登录响应非 JSON: HTTP ' + loginResp.status };
  }

  let jwt = null;
  if (loginData.status === 200) {
    if (loginData.info && loginData.info.jwt) jwt = loginData.info.jwt;
    else if (loginData.jwt) jwt = loginData.jwt;
    else if (loginData.data && loginData.data.jwt) jwt = loginData.data.jwt;
  }
  if (!jwt) {
    const errMsg = loginData.msg || loginData.info?.msg || loginData.message || '登录失败';
    return { ok: false, error: errMsg };
  }
  return { ok: true, jwt, baseUrl, origin: targetOrigin };
}

/** 带 JWT 请求魔方 API（v1 或 provision） */
async function serverApiRequest(providerBase, jwt, relativePath, method, bodyStr, isProvision) {
  let baseUrl = providerBase;
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  const origin = new URL(baseUrl).origin;
  const targetBase = isProvision ? (origin + '/') : baseUrl;
  const rel = String(relativePath || '').replace(/^\//, '');
  const targetUrl = new URL(rel, targetBase).toString();

  const headers = new Headers();
  headers.set('Accept', '*/*');
  headers.set('Accept-Language', 'zh-CN,zh;q=0.8,en;q=0.7');
  headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  headers.set('Origin', origin);
  headers.set('Referer', origin + '/');
  headers.set('Authorization', 'Bearer ' + jwt);
  headers.set('Cookie', 'ZJMF_8F073A284ADDCA6A=' + jwt);

  const resp = await fetch(targetUrl, {
    method: method || 'GET',
    headers,
    body: method !== 'GET' && method !== 'HEAD' ? bodyStr : undefined,
    redirect: 'follow'
  });
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await resp.json();
  }
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: resp.status, raw: text };
  }
}

function isHostRunningStatus(data) {
  if (!data) return false;
  const s = String(data.status || '').toLowerCase();
  // 开机 / 运行中 视为正常，不恢复
  if (s === 'on' || s === 'running' || s === 'online' || s === 'active') return true;
  const des = String(data.des || data.description || '').toLowerCase();
  if (des.includes('运行') || des.includes('开机') || des === 'on') return true;
  return false;
}

/** 判断 provision 操作是否真正成功（含「不支持硬重启」等文案） */
function isProvisionOpSuccess(resp) {
  if (!resp || resp.status !== 200) return false;
  if (resp.data && resp.data._second_verify) return false;
  const msg = String(resp.msg || resp.info || resp.message || '');
  if (/不支持|失败|error|fail|未开通|无法|禁止|无效|错误/i.test(msg)) return false;
  return true;
}

function extractOpError(resp, fallback) {
  if (!resp) return fallback || '未知错误';
  if (typeof resp.msg === 'string' && resp.msg) return resp.msg;
  if (typeof resp.info === 'string' && resp.info) return resp.info;
  if (typeof resp.message === 'string' && resp.message) return resp.message;
  return fallback || '操作失败';
}

/**
 * 恢复单机：优先 hard_reboot；失败/不支持/需二次验证 → reboot 兜底
 */
async function serverRecoverHost(providerBase, jwt, hostId) {
  const hardParams = new URLSearchParams();
  hardParams.append('id', String(hostId));
  hardParams.append('func', 'hard_reboot');
  let hardErr = '';
  try {
    const hard = await serverApiRequest(providerBase, jwt, 'provision/default', 'POST', hardParams.toString(), true);
    if (isProvisionOpSuccess(hard)) {
      return { success: true, action: 'hard_reboot', msg: hard.msg || '硬重启成功' };
    }
    hardErr = extractOpError(hard, '硬重启失败');
    if (hard && hard.data && hard.data._second_verify) {
      hardErr = '硬重启需二次验证';
    }
  } catch (e) {
    hardErr = e.message || '硬重启异常';
  }

  const softParams = new URLSearchParams();
  softParams.append('id', String(hostId));
  softParams.append('func', 'reboot');
  try {
    const soft = await serverApiRequest(providerBase, jwt, 'provision/default', 'POST', softParams.toString(), true);
    if (isProvisionOpSuccess(soft)) {
      return {
        success: true,
        action: 'reboot',
        msg: (soft.msg || '重启成功') + (hardErr ? '（硬重启: ' + hardErr + '）' : '')
      };
    }
    return {
      success: false,
      action: 'reboot',
      error: extractOpError(soft, '重启失败') + (hardErr ? '；硬重启: ' + hardErr : '')
    };
  } catch (e) {
    return {
      success: false,
      action: 'reboot',
      error: (e.message || '重启异常') + (hardErr ? '；硬重启: ' + hardErr : '')
    };
  }
}

/** 拉取某服务商全部主机（分页） */
async function serverFetchAllHosts(providerBase, jwt) {
  const all = [];
  let page = 1;
  const limit = 100;
  for (; page <= 20; page++) {
    const hostsResp = await serverApiRequest(
      providerBase, jwt, 'hosts?page=' + page + '&limit=' + limit, 'GET', null, false
    );
    if (!hostsResp || hostsResp.status !== 200) {
      if (page === 1) {
        return {
          ok: false,
          error: (hostsResp && (hostsResp.msg || hostsResp.info)) || '获取服务器列表失败',
          hosts: []
        };
      }
      break;
    }
    const list = (hostsResp.data && hostsResp.data.host) || [];
    if (!list.length) break;
    for (const h of list) all.push(h);
    const total = Number(hostsResp.data && hostsResp.data.total);
    if (!isNaN(total) && all.length >= total) break;
    if (list.length < limit) break;
  }
  return { ok: true, hosts: all };
}

function sleepMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 写入 KV 的 cursor 去掉 jwt，续跑时重新登录 */
function sanitizeCursorForKv(cursor) {
  if (!cursor) return null;
  return {
    providerIdx: cursor.providerIdx || 0,
    hostIdx: cursor.hostIdx || 0,
    hostIds: cursor.hostIds || null,
    providerId: cursor.providerId || null,
    jwt: null,
    baseUrl: null,
    pname: cursor.pname || null
  };
}

/**
 * 执行/续跑一轮巡检。
 * options: { force, isContinue }
 * 返回 needContinue=true 时调用方应 waitUntil 自调用 continue
 *
 * 关键：外部 cron 只打 /api/schedule/run（无 continue=1）时，
 * 若 KV 里仍有未完成 cursor，必须自动续跑，绝不能重置到第 0 台，
 * 否则关页后每分钟只会重复处理前几台。
 */
async function executeScheduleRound(env, options = {}) {
  const force = !!options.force;
  const isContinue = !!options.isContinue;
  let cfg = await getScheduleConfig(env);

  // 有未完成分片进度：非 force 一律续跑（cron 无 continue 参数也能接上）
  const hasIncomplete = !!(cfg.cursor && (
    cfg.running ||
    (Array.isArray(cfg.cursor.hostIds) && cfg.cursor.hostIds.length > 0) ||
    (cfg.cursor.providerIdx > 0) ||
    (cfg.cursor.hostIdx > 0)
  ));
  const resume = !force && hasIncomplete;

  if (!cfg.enabled && !force && !resume) {
    return { skipped: true, reason: 'disabled', config: cfg };
  }

  // 显式 continue 但无进度
  if (isContinue && !hasIncomplete) {
    return { skipped: true, reason: 'no_cursor', config: cfg };
  }

  if (resume) {
    // 另一分片刚写入（15s 内）则避免双开；过期则接管续跑
    if (cfg.running && cfg.updatedAt && !isContinue) {
      const updated = new Date(cfg.updatedAt).getTime();
      if (!isNaN(updated) && Date.now() - updated < 15000) {
        return {
          skipped: true,
          reason: 'already_running',
          needContinue: true,
          config: cfg,
          summary: formatScheduleSummary(cfg.stats) + (cfg.progress ? ' · ' + cfg.progress : '')
        };
      }
    }
  } else {
    // 新一轮：未到点则跳过（force 除外）
    if (!force && cfg.nextRunAt) {
      const next = new Date(cfg.nextRunAt).getTime();
      if (!isNaN(next) && Date.now() < next - 2000) {
        return { skipped: true, reason: 'not_due', config: cfg, nextRunAt: cfg.nextRunAt };
      }
    }
    // 防并发：非 force 且 running 未过期 → 跳过；force 或过期则强制开新一轮
    if (!force && cfg.running && cfg.updatedAt) {
      const updated = new Date(cfg.updatedAt).getTime();
      if (!isNaN(updated) && Date.now() - updated < SCHEDULE_STALE_MS) {
        return { skipped: true, reason: 'already_running', config: cfg };
      }
    }
    // 开新一轮前清掉旧进度
    cfg.running = false;
    cfg.cursor = null;
    cfg.progress = null;
  }

  const logBuf = createLogBuffer();
  const startedAt = Date.now();
  const providers = await getProviders(env);

  let stats;
  let cursor;
  if (resume) {
    stats = Object.assign(defaultRoundStats(), cfg.stats || {});
    cursor = Object.assign({
      providerIdx: 0, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null, pname: null
    }, cfg.cursor || {});
    // 心跳：标记本分片已接管，供并发跳过
    cfg.running = true;
    cfg.stats = stats;
    cfg.cursor = sanitizeCursorForKv(cursor);
    await saveScheduleConfig(env, cfg);
    logBuf.push('info', '续跑巡检', 'p=' + (cursor.providerIdx || 0) + ' h=' + (cursor.hostIdx || 0) +
      (cursor.hostIds ? '/' + cursor.hostIds.length : '') + (isContinue ? ' (continue)' : ' (cron/auto)'));
  } else {
    stats = defaultRoundStats();
    cursor = { providerIdx: 0, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null, pname: null };
    cfg.running = true;
    cfg.cursor = sanitizeCursorForKv(cursor);
    cfg.stats = stats;
    cfg.progress = '0%';
    await saveScheduleConfig(env, cfg);
    logBuf.push('info', '开始巡检', 'interval=' + (cfg.intervalMin || SCHEDULE_DEFAULT_INTERVAL) + 'min force=' + force);
  }

  if (!providers || providers.length === 0) {
    logBuf.push('warning', '无服务商，跳过');
    await logBuf.flush(env);
    return await finishScheduleRound(env, cfg, stats, logBuf, true);
  }

  try {
    let pIdx = cursor.providerIdx || 0;

    while (pIdx < providers.length) {
      if (Date.now() - startedAt > SCHEDULE_TIME_BUDGET_MS) {
        cursor.providerIdx = pIdx;
        // 不把 jwt 写入 KV（安全 + 体积）；续跑时重新登录
        cfg.cursor = sanitizeCursorForKv(cursor);
        cfg.stats = stats;
        cfg.running = true;
        cfg.progress = '服务商 ' + (pIdx + 1) + '/' + providers.length;
        await saveScheduleConfig(env, cfg);
        await logBuf.flush(env);
        return {
          skipped: false,
          success: true,
          partial: true,
          needContinue: true,
          summary: formatScheduleSummary(stats) + '（分片续跑中…）',
          stats,
          config: cfg
        };
      }

      const provider = providers[pIdx];
      const pname = provider.name || provider.id || 'unknown';

      // 需要登录 + 拉列表（新服务商或 hostIds 未缓存）；续跑时重新登录拿新 JWT
      if (!cursor.hostIds || cursor.providerId !== provider.id || !cursor.jwt || !cursor.baseUrl) {
        if (!provider.account || !provider.apiKey) {
          logBuf.push('warning', '[' + pname + '] 缺少凭证，跳过');
          stats.failed++;
          pIdx++;
          cursor = { providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null };
          continue;
        }

        const login = await serverLoginProvider(provider);
        if (!login.ok) {
          logBuf.push('error', '[' + pname + '] 登录失败', login.error);
          stats.failed++;
          pIdx++;
          cursor = { providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null };
          continue;
        }

        let hostIds = cursor.hostIds;
        let hostIdx = cursor.hostIdx || 0;
        // 同一服务商续跑：保留 hostIds/hostIdx，只刷新 jwt
        if (!hostIds || cursor.providerId !== provider.id) {
          const hostsRes = await serverFetchAllHosts(login.baseUrl, login.jwt);
          if (!hostsRes.ok) {
            logBuf.push('error', '[' + pname + '] 获取列表失败', hostsRes.error);
            stats.failed++;
            pIdx++;
            cursor = { providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null };
            continue;
          }
          hostIds = hostsRes.hosts.map(h => h.id).filter(Boolean);
          hostIdx = 0;
          logBuf.push('info', '[' + pname + '] 开始检查', '共 ' + hostIds.length + ' 台');
        } else {
          logBuf.push('info', '[' + pname + '] 续跑', '从第 ' + (hostIdx + 1) + '/' + hostIds.length + ' 台');
        }

        cursor = {
          providerIdx: pIdx,
          hostIdx,
          hostIds,
          providerId: provider.id,
          jwt: login.jwt,
          baseUrl: login.baseUrl,
          pname
        };
      }

      const hostIds = cursor.hostIds || [];
      let hIdx = cursor.hostIdx || 0;

      while (hIdx < hostIds.length) {
        if (Date.now() - startedAt > SCHEDULE_TIME_BUDGET_MS) {
          cursor.hostIdx = hIdx;
          cursor.providerIdx = pIdx;
          cfg.cursor = sanitizeCursorForKv(cursor);
          cfg.stats = stats;
          cfg.running = true;
          cfg.progress = '[' + (cursor.pname || pname) + '] ' + hIdx + '/' + hostIds.length;
          await saveScheduleConfig(env, cfg);
          await logBuf.flush(env);
          return {
            skipped: false,
            success: true,
            partial: true,
            needContinue: true,
            summary: formatScheduleSummary(stats) + ' · 续跑 ' + cfg.progress,
            stats,
            config: cfg
          };
        }

        const hostId = hostIds[hIdx];
        hIdx++;
        try {
          const stParams = new URLSearchParams();
          stParams.append('id', String(hostId));
          stParams.append('func', 'status');
          const st = await serverApiRequest(cursor.baseUrl, cursor.jwt, 'provision/default', 'POST', stParams.toString(), true);

          if (st && st.status === 200) {
            stats.checked++;
            const data = st.data || {};
            if (isHostRunningStatus(data)) {
              stats.running++;
            } else {
              const des = data.des || data.status || '非运行中';
              logBuf.push('warning', '[' + pname + '] #' + hostId + ' 非运行中 (' + des + ')，尝试恢复');
              const rec = await serverRecoverHost(cursor.baseUrl, cursor.jwt, hostId);
              if (rec.success) {
                stats.recovered++;
                logBuf.push('success', '[' + pname + '] #' + hostId + ' ' + rec.action + ' 成功', rec.msg);
              } else {
                stats.failed++;
                logBuf.push('error', '[' + pname + '] #' + hostId + ' 恢复失败', rec.error);
              }
            }
          } else {
            stats.failed++;
            logBuf.push('error', '[' + pname + '] #' + hostId + ' 查状态失败', extractOpError(st, '查状态失败'));
          }
        } catch (hostErr) {
          stats.failed++;
          logBuf.push('error', '[' + pname + '] #' + hostId + ' 异常', hostErr.message);
        }

        await sleepMs(SCHEDULE_HOST_GAP_MS);
      }

      // 当前服务商完成
      pIdx++;
      cursor = { providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null };
    }

    await logBuf.flush(env);
    return await finishScheduleRound(env, cfg, stats, logBuf, false);
  } catch (e) {
    logBuf.push('error', '巡检异常', e.message);
    await logBuf.flush(env);
    cfg = await getScheduleConfig(env);
    // 保留 cursor 以便下次续跑，但若无 cursor 则清 running
    if (!cfg.cursor) {
      cfg.running = false;
    }
    cfg.lastSummary = '执行异常: ' + e.message;
    await saveScheduleConfig(env, cfg);
    return {
      skipped: false,
      success: false,
      error: e.message,
      needContinue: !!cfg.cursor,
      config: cfg
    };
  }
}

function formatScheduleSummary(stats) {
  const s = stats || defaultRoundStats();
  return '检查 ' + s.checked + ' · 运行中 ' + s.running + ' · 已恢复 ' + s.recovered + ' · 失败 ' + s.failed;
}

async function finishScheduleRound(env, cfgIn, stats, logBuf, emptyProviders) {
  const summary = formatScheduleSummary(stats);
  const now = new Date();
  let cfg = await getScheduleConfig(env);
  const intervalMin = Math.max(
    SCHEDULE_MIN_INTERVAL,
    Math.min(SCHEDULE_MAX_INTERVAL, cfg.intervalMin || SCHEDULE_DEFAULT_INTERVAL)
  );
  cfg.running = false;
  cfg.cursor = null;
  cfg.progress = null;
  cfg.stats = stats;
  cfg.lastRunAt = now.toISOString();
  cfg.lastSummary = summary;
  if (cfg.enabled) {
    cfg.nextRunAt = new Date(now.getTime() + intervalMin * 60 * 1000).toISOString();
  } else {
    cfg.nextRunAt = null;
  }
  await saveScheduleConfig(env, cfg);
  if (logBuf) {
    logBuf.push('info', emptyProviders ? '本轮结束（无服务商）' : '本轮完成', summary);
    await logBuf.flush(env);
  } else {
    await appendScheduleLog(env, 'info', emptyProviders ? '本轮结束（无服务商）' : '本轮完成', summary);
  }
  return {
    skipped: false,
    success: true,
    partial: false,
    needContinue: false,
    summary,
    stats,
    config: cfg
  };
}

/** 后台自续跑：waitUntil 再请求自己，把剩余机器跑完 */
function scheduleContinueIfNeeded(context, request, result) {
  if (!result || !result.needContinue || !context.waitUntil) return;
  try {
    const base = new URL(request.url);
    const contUrl = new URL(base.pathname, base.origin);
    contUrl.searchParams.set('continue', '1');
    context.waitUntil(
      fetch(contUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Schedule-Continue': '1' },
        body: '{}'
      }).catch(err => console.warn('schedule continue fetch failed:', err))
    );
  } catch (e) {
    console.warn('scheduleContinueIfNeeded error:', e);
  }
}

/** GET /api/schedule/status */
async function handleScheduleStatus(context) {
  const { env } = context;
  if (!env.AUTH_KV) {
    return jsonResponse({ success: false, error: 'KV 存储未配置' }, 500);
  }
  try {
    const config = await getScheduleConfig(env);
    const logs = await getScheduleLogs(env);
    return jsonResponse({ success: true, config, logs: logs.slice(0, 30) });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

/** POST /api/schedule/start  Body: { intervalMin?: number } */
async function handleScheduleStart(context) {
  const { request, env } = context;
  if (!env.AUTH_KV) {
    return jsonResponse({ success: false, error: 'KV 存储未配置' }, 500);
  }
  try {
    let intervalMin = SCHEDULE_DEFAULT_INTERVAL;
    try {
      const body = await request.json();
      if (body && body.intervalMin != null) {
        intervalMin = parseInt(body.intervalMin, 10);
      }
    } catch { /* empty body ok */ }

    if (!intervalMin || isNaN(intervalMin) || intervalMin < SCHEDULE_MIN_INTERVAL) intervalMin = SCHEDULE_MIN_INTERVAL;
    if (intervalMin > SCHEDULE_MAX_INTERVAL) intervalMin = SCHEDULE_MAX_INTERVAL;

    const providers = await getProviders(env);
    if (!providers || providers.length === 0) {
      return jsonResponse({ success: false, error: '请先添加至少一个服务商' }, 400);
    }

    let cfg = await getScheduleConfig(env);
    cfg.enabled = true;
    cfg.intervalMin = intervalMin;
    cfg.nextRunAt = new Date().toISOString();
    cfg.running = false;
    cfg.cursor = null;
    cfg.progress = null;
    await saveScheduleConfig(env, cfg);
    await appendScheduleLog(env, 'info', '定时已启动', '间隔 ' + intervalMin + ' 分钟，覆盖全部服务商全部机器');

    // 启动后立即跑一轮（同步跑完分片，waitUntil 续跑剩余）
    let runResult = null;
    try {
      runResult = await executeScheduleRound(env, { force: true });
      scheduleContinueIfNeeded(context, request, runResult);
    } catch (runErr) {
      console.warn('schedule start immediate run error:', runErr);
    }

    cfg = await getScheduleConfig(env);
    return jsonResponse({
      success: true,
      msg: '服务端定时已启动。关页后请用外部 cron 每分钟访问 /api/schedule/run，否则无法到点执行。',
      config: cfg,
      run: runResult
    });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

/** POST /api/schedule/stop */
async function handleScheduleStop(context) {
  const { env } = context;
  if (!env.AUTH_KV) {
    return jsonResponse({ success: false, error: 'KV 存储未配置' }, 500);
  }
  try {
    let cfg = await getScheduleConfig(env);
    cfg.enabled = false;
    cfg.nextRunAt = null;
    cfg.running = false;
    cfg.cursor = null;
    cfg.progress = null;
    await saveScheduleConfig(env, cfg);
    await appendScheduleLog(env, 'info', '定时已停止');
    return jsonResponse({ success: true, msg: '服务端定时已停止', config: cfg });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

/** GET|POST /api/schedule/run  ?force=1 立即执行  ?continue=1 分片续跑 */
async function handleScheduleRun(context) {
  const { request, env } = context;
  if (!env.AUTH_KV) {
    return jsonResponse({ success: false, error: 'KV 存储未配置' }, 500);
  }
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
    const isContinue = url.searchParams.get('continue') === '1' || url.searchParams.get('continue') === 'true';
    const result = await executeScheduleRound(env, { force, isContinue });
    scheduleContinueIfNeeded(context, request, result);
    return jsonResponse({ success: true, ...result });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

/** GET /api/schedule/logs */
async function handleScheduleLogs(context) {
  const { env } = context;
  if (!env.AUTH_KV) {
    return jsonResponse({ success: false, error: 'KV 存储未配置' }, 500);
  }
  try {
    const logs = await getScheduleLogs(env);
    return jsonResponse({ success: true, logs });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

// ==================== OPTIONS 预检请求 ====================

// 处理 OPTIONS 预检请求
export async function onRequestOptions(context) {
  const { request } = context;
  
  const origin = request.headers.get('Origin') || '*';
  
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin, Referer, Accept, Accept-Language, Cookie',
      'Access-Control-Max-Age': '86400',
    },
  });
}