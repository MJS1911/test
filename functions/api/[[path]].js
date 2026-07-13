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
/** 单次调用时间预算(ms)：留足写 KV 余量，避免硬超时丢进度；到期后 yielded 让出 */
const SCHEDULE_TIME_BUDGET_MS = 16000;
/** 卡住 running 超过此时长则强制解锁续跑 */
const SCHEDULE_STALE_MS = 60 * 1000;
/** 主机间最小间隔，避免打爆目标站 */
const SCHEDULE_HOST_GAP_MS = 20;
/** 并发锁：running 且未 yielded 时，心跳在此时间内视为「有人在跑」 */
const SCHEDULE_LOCK_MS = 12000;
/** waitUntil 后台最多续跑跳数；用尽后 hop 归零继续，关页无前端也能跑完 */
const SCHEDULE_CONTINUE_MAX_HOPS = 40;

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
    roundId: null,
    claimToken: null,
    /** true=本分片已让出，允许 continue/cron 立刻接棒（解决 waitUntil 被锁挡住只跑 1 台） */
    yielded: false,
    updatedAt: null
  };
}

function newRoundId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
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

/** 状态文案是否明确为关机/关闭（此类机硬重启/重启常无效，优先开机） */
function isHostClearlyOff(data) {
  if (!data) return false;
  const s = String(data.status || '').toLowerCase();
  if (s === 'off' || s === 'stopped' || s === 'shutdown' || s === 'poweroff' || s === 'powered_off') return true;
  const des = String(data.des || data.description || '').toLowerCase();
  if (des.includes('关机') || des.includes('关闭') || des.includes('已停止') || des === 'off') return true;
  return false;
}

/**
 * 恢复单机：
 * - 明确关机态：优先 on（关机机 hard/soft 重启常无效，省时间便于关页全量）
 * - 其它非运行：hard_reboot → reboot → on
 */
async function serverRecoverHost(providerBase, jwt, hostId, statusData) {
  const prevErrs = [];
  const preferOnFirst = isHostClearlyOff(statusData);

  async function tryOp(func, label) {
    try {
      const params = new URLSearchParams();
      params.append('id', String(hostId));
      params.append('func', func);
      const resp = await serverApiRequest(providerBase, jwt, 'provision/default', 'POST', params.toString(), true);
      if (isProvisionOpSuccess(resp)) {
        return {
          ok: true,
          result: {
            success: true,
            action: func,
            msg: (resp.msg || (label + '成功')) + (prevErrs.length ? '（' + prevErrs.join('；') + '）' : '')
          }
        };
      }
      let err = extractOpError(resp, label + '失败');
      if (resp && resp.data && resp.data._second_verify) err = label + '需二次验证';
      prevErrs.push(label + ': ' + err);
      return { ok: false };
    } catch (e) {
      prevErrs.push(label + ': ' + (e.message || label + '异常'));
      return { ok: false };
    }
  }

  // 关机态：先开机
  if (preferOnFirst) {
    const onFirst = await tryOp('on', '开机');
    if (onFirst.ok) return onFirst.result;
    // 开机失败再走 hard → reboot → on（on 已试过，后面链仍含 on 兜底）
  }

  const hard = await tryOp('hard_reboot', '硬重启');
  if (hard.ok) return hard.result;

  const soft = await tryOp('reboot', '重启');
  if (soft.ok) return soft.result;

  // 若关机态已试过 on，避免重复；否则再试 on
  if (!preferOnFirst) {
    const onLast = await tryOp('on', '开机');
    if (onLast.ok) return onLast.result;
  }

  return {
    success: false,
    action: preferOnFirst ? 'on' : 'on',
    error: (prevErrs.length ? prevErrs.join('；') : '恢复失败')
  };
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
    pname: cursor.pname || null,
    roundId: cursor.roundId || null
  };
}

/**
 * 判断是否有未完成的分片进度（必须续跑，不能开新一轮）
 */
function hasIncompleteCursor(cfg) {
  if (!cfg) return false;
  // 已开跑 / 主动让出等待续跑
  if (cfg.running && cfg.roundId) return true;
  if (cfg.yielded && (cfg.cursor || cfg.roundId)) return true;
  if (!cfg.cursor) return false;
  const c = cfg.cursor;
  if (Array.isArray(c.hostIds) && c.hostIds.length > 0 && (c.hostIdx || 0) < c.hostIds.length) return true;
  if ((c.providerIdx || 0) > 0) return true;
  if ((c.hostIdx || 0) > 0) return true;
  // 有 hostIds 列表但还没扫完（含 hostIdx=0 刚拉完列表）
  if (Array.isArray(c.hostIds) && c.hostIds.length > 0) return true;
  // running + cursor 存在（登录中）
  if (cfg.running && cfg.cursor) return true;
  // 有 roundId + cursor 说明本轮未 finish
  if (cfg.roundId && cfg.cursor) return true;
  return false;
}

/**
 * 执行/续跑一轮巡检。
 * options: { force, isContinue, bodyCursor, hop }
 * 返回 needContinue=true 时调用方应 waitUntil 自调用 continue
 *
 * 关键修复（关 3 台只成功 1 台）：
 * 1. 时间预算 14s，每机处理完立刻写 KV，硬超时不丢进度
 * 2. waitUntil 多跳续跑 + body.cursor 快照，不依赖 KV 最终一致
 * 3. 外部 cron 无 continue 时自动 resume，绝不重置到第 0 台
 * 4. 认领锁：进入执行前写 claimToken，避免双开漏机/空转
 * 5. force 且有未完成进度时默认续跑（除非 forceNew）
 */
async function executeScheduleRound(env, options = {}) {
  const force = !!options.force;
  const forceNew = !!options.forceNew;
  const isContinue = !!options.isContinue;
  const bodyCursor = options.bodyCursor || null;
  const hop = Math.max(0, parseInt(options.hop, 10) || 0);
  let cfg = await getScheduleConfig(env);

  // body 带来的 cursor：必须 roundId 一致，防止旧 waitUntil 覆盖新一轮
  if (isContinue && bodyCursor && typeof bodyCursor === 'object') {
    const bodyRound = bodyCursor.roundId || null;
    const cfgRound = cfg.roundId || (cfg.cursor && cfg.cursor.roundId) || null;
    const roundMismatch = !!(cfgRound && bodyRound && bodyRound !== cfgRound);
    if (!roundMismatch) {
      const bodyHasHosts = Array.isArray(bodyCursor.hostIds) && bodyCursor.hostIds.length > 0;
      const bodyAhead = bodyHasHosts && (
        !cfg.cursor ||
        !hasIncompleteCursor(cfg) ||
        (bodyCursor.providerIdx || 0) > (cfg.cursor.providerIdx || 0) ||
        ((bodyCursor.providerIdx || 0) === (cfg.cursor.providerIdx || 0) &&
          (bodyCursor.hostIdx || 0) >= (cfg.cursor.hostIdx || 0))
      );
      if (bodyAhead || (bodyHasHosts && !cfg.cursor)) {
        cfg.cursor = sanitizeCursorForKv(bodyCursor);
        if (bodyCursor.stats) cfg.stats = Object.assign(defaultRoundStats(), bodyCursor.stats);
        if (bodyRound) cfg.roundId = bodyRound;
        cfg.running = true;
      }
    }
  }

  const hasIncomplete = hasIncompleteCursor(cfg);
  // 有未完成进度：一律续跑（含 force=1 立即巡检），除非 forceNew 强制开新一轮
  // 无进度：force 或到期 → 开新一轮
  const resume = hasIncomplete && !forceNew;

  if (!cfg.enabled && !force && !resume) {
    return { skipped: true, reason: 'disabled', config: cfg };
  }

  // continue 请求绝不开新一轮：无进度则直接结束
  if (isContinue && !hasIncomplete) {
    return { skipped: true, reason: 'no_cursor', config: cfg, needContinue: false };
  }

  // 并发锁：running 且心跳新鲜 → 跳过；但 yielded=true 表示上一分片已主动让出，continue/cron 可立刻接棒
  if (cfg.running && cfg.updatedAt && !cfg.yielded) {
    const updated = new Date(cfg.updatedAt).getTime();
    const age = isNaN(updated) ? Infinity : (Date.now() - updated);
    if (age < SCHEDULE_LOCK_MS) {
      return {
        skipped: true,
        reason: 'already_running',
        needContinue: !!(cfg.cursor || hasIncomplete),
        config: cfg,
        summary: formatScheduleSummary(cfg.stats) + (cfg.progress ? ' · ' + cfg.progress : ''),
        continueCursor: cfg.cursor
          ? Object.assign(sanitizeCursorForKv(cfg.cursor) || {}, { stats: Object.assign({}, cfg.stats || {}) })
          : null
      };
    }
    // 非 resume 新一轮：stale 内也跳过
    if (!resume && !force && age < SCHEDULE_STALE_MS) {
      return {
        skipped: true,
        reason: 'already_running',
        needContinue: !!cfg.cursor,
        config: cfg,
        continueCursor: cfg.cursor
          ? Object.assign(sanitizeCursorForKv(cfg.cursor) || {}, { stats: Object.assign({}, cfg.stats || {}) })
          : null
      };
    }
  }

  if (!resume) {
    if (!force && cfg.nextRunAt) {
      const next = new Date(cfg.nextRunAt).getTime();
      if (!isNaN(next) && Date.now() < next - 2000) {
        return { skipped: true, reason: 'not_due', config: cfg, nextRunAt: cfg.nextRunAt };
      }
    }
    cfg.running = false;
    cfg.cursor = null;
    cfg.progress = null;
    cfg.roundId = newRoundId();
    cfg.claimToken = null;
    cfg.yielded = false;
  }

  const logBuf = createLogBuffer();
  const startedAt = Date.now();
  const providers = await getProviders(env);
  const roundId = cfg.roundId || newRoundId();
  // 接棒时换新 claimToken；yielded 或锁过期时允许新 worker 接管
  const claimToken = newRoundId();
  cfg.roundId = roundId;
  cfg.claimToken = claimToken;
  cfg.yielded = false; // 本 worker 已认领，清除让出标记

  let stats;
  let cursor;
  if (resume) {
    stats = Object.assign(defaultRoundStats(), cfg.stats || {});
    cursor = Object.assign({
      providerIdx: 0, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null, pname: null, roundId
    }, cfg.cursor || {});
    cursor.roundId = roundId;
    cfg.running = true;
    cfg.stats = stats;
    cfg.cursor = sanitizeCursorForKv(cursor);
    cfg.progress = cfg.progress || ('续跑 p=' + (cursor.providerIdx || 0) + ' h=' + (cursor.hostIdx || 0));
    await saveScheduleConfig(env, cfg);
    logBuf.push('info', '续跑巡检', 'p=' + (cursor.providerIdx || 0) + ' h=' + (cursor.hostIdx || 0) +
      (cursor.hostIds ? '/' + cursor.hostIds.length : '') +
      (isContinue ? ' (continue hop=' + hop + ')' : ' (cron/auto)'));
  } else {
    stats = defaultRoundStats();
    cursor = { providerIdx: 0, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null, pname: null, roundId };
    cfg.running = true;
    cfg.cursor = sanitizeCursorForKv(cursor);
    cfg.stats = stats;
    cfg.progress = '0%';
    await saveScheduleConfig(env, cfg);
    logBuf.push('info', '开始巡检', 'interval=' + (cfg.intervalMin || SCHEDULE_DEFAULT_INTERVAL) +
      'min force=' + force + ' round=' + roundId + ' providers=' + (providers ? providers.length : 0));
  }

  if (!providers || providers.length === 0) {
    logBuf.push('warning', '无服务商，跳过');
    await logBuf.flush(env);
    return await finishScheduleRound(env, cfg, stats, logBuf, true);
  }

  /** 写回分片进度；返回最终 hostIdx（禁止回退，供外层循环同步）。若 claim 被抢占返回 -1 */
  async function persistPartial(pIdx, hIdx, pname, hostIdsLen) {
    try {
      const latest = await getScheduleConfig(env);
      // 其他 worker 已抢占本轮 → 本 worker 退出，避免双开漏机/重复
      if (latest && latest.roundId && latest.roundId !== roundId) {
        return -1;
      }
      if (latest && latest.claimToken && latest.claimToken !== claimToken &&
          latest.running && latest.updatedAt) {
        const u = new Date(latest.updatedAt).getTime();
        if (!isNaN(u) && Date.now() - u < SCHEDULE_LOCK_MS) {
          return -1;
        }
      }
      if (latest && latest.cursor && latest.cursor.hostIds && cursor.hostIds &&
          latest.cursor.providerId === cursor.providerId &&
          (latest.cursor.providerIdx || 0) === pIdx) {
        const latestH = latest.cursor.hostIdx || 0;
        if (latestH > hIdx) {
          hIdx = latestH;
          if (latest.stats) {
            stats.checked = Math.max(stats.checked, latest.stats.checked || 0);
            stats.running = Math.max(stats.running, latest.stats.running || 0);
            stats.recovered = Math.max(stats.recovered, latest.stats.recovered || 0);
            stats.failed = Math.max(stats.failed, latest.stats.failed || 0);
          }
        }
      }
    } catch (_) { /* ignore */ }
    cursor.providerIdx = pIdx;
    cursor.hostIdx = hIdx;
    cursor.roundId = roundId;
    cfg.cursor = sanitizeCursorForKv(cursor);
    cfg.stats = stats;
    cfg.running = true;
    cfg.roundId = roundId;
    cfg.claimToken = claimToken;
    cfg.progress = '[' + (cursor.pname || pname || '?') + '] ' + hIdx + '/' + (hostIdsLen || (cursor.hostIds || []).length);
    await saveScheduleConfig(env, cfg);
    return hIdx;
  }

  async function yieldAndPartial() {
    // 主动让出：running=false + yielded=true，waitUntil/前端/cron 可立刻接棒（不被锁挡住）
    // cursor/stats/roundId 保留，hasIncompleteCursor 仍为 true
    cfg.yielded = true;
    cfg.running = false;
    cfg.cursor = sanitizeCursorForKv(cursor);
    cfg.stats = stats;
    cfg.roundId = roundId;
    cfg.claimToken = claimToken;
    cfg.progress = (cfg.progress || '') + ' · 等待续跑';
    try {
      await saveScheduleConfig(env, cfg);
    } catch (_) { /* ignore */ }
    return {
      skipped: false,
      success: true,
      partial: true,
      needContinue: true,
      hop,
      summary: formatScheduleSummary(stats) + ' · 续跑 ' + (cfg.progress || ''),
      stats,
      config: cfg,
      continueCursor: Object.assign(sanitizeCursorForKv(cursor) || {}, {
        stats: Object.assign({}, stats),
        roundId
      })
    };
  }

  try {
    let pIdx = cursor.providerIdx || 0;

    while (pIdx < providers.length) {
      if (Date.now() - startedAt > SCHEDULE_TIME_BUDGET_MS) {
        const saved = await persistPartial(pIdx, cursor.hostIdx || 0, cursor.pname, (cursor.hostIds || []).length);
        if (saved < 0) {
          await logBuf.flush(env);
          return {
            skipped: true,
            reason: 'claim_lost',
            needContinue: true,
            config: cfg,
            continueCursor: Object.assign(sanitizeCursorForKv(cursor) || {}, { stats: Object.assign({}, stats) })
          };
        }
        await logBuf.flush(env);
        return await yieldAndPartial();
      }

      const provider = providers[pIdx];
      const pname = provider.name || provider.id || ('p' + pIdx);
      const providerKey = provider.id != null ? provider.id : ('idx_' + pIdx);

      // 需要登录 + 拉列表；续跑时重新登录拿新 JWT
      if (!cursor.hostIds || cursor.providerId !== providerKey || !cursor.jwt || !cursor.baseUrl) {
        if (!provider.account || !provider.apiKey) {
          logBuf.push('warning', '[' + pname + '] 缺少凭证，跳过');
          stats.failed++;
          pIdx++;
          cursor = { providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null, pname: null, roundId };
          continue;
        }

        const login = await serverLoginProvider(provider);
        if (!login.ok) {
          logBuf.push('error', '[' + pname + '] 登录失败', login.error);
          stats.failed++;
          pIdx++;
          cursor = { providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null, pname: null, roundId };
          continue;
        }

        let hostIds = cursor.hostIds;
        let hostIdx = cursor.hostIdx || 0;
        if (!hostIds || cursor.providerId !== providerKey) {
          const hostsRes = await serverFetchAllHosts(login.baseUrl, login.jwt);
          if (!hostsRes.ok) {
            logBuf.push('error', '[' + pname + '] 获取列表失败', hostsRes.error);
            stats.failed++;
            pIdx++;
            cursor = { providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null, jwt: null, baseUrl: null, pname: null, roundId };
            continue;
          }
          hostIds = hostsRes.hosts.map(h => h.id).filter(id => id != null && id !== '');
          hostIdx = 0;
          logBuf.push('info', '[' + pname + '] 开始检查', '共 ' + hostIds.length + ' 台');
        } else {
          logBuf.push('info', '[' + pname + '] 续跑', '从第 ' + (hostIdx + 1) + '/' + hostIds.length + ' 台');
        }

        cursor = {
          providerIdx: pIdx,
          hostIdx,
          hostIds,
          providerId: providerKey,
          jwt: login.jwt,
          baseUrl: login.baseUrl,
          pname,
          roundId
        };
        // 登录+拉列表后立刻落盘，防止后续硬超时丢 hostIds
        hostIdx = await persistPartial(pIdx, hostIdx, pname, hostIds.length);
        if (hostIdx < 0) {
          await logBuf.flush(env);
          return {
            skipped: true,
            reason: 'claim_lost',
            needContinue: true,
            config: cfg,
            continueCursor: Object.assign(sanitizeCursorForKv(cursor) || {}, { stats: Object.assign({}, stats) })
          };
        }
        cursor.hostIdx = hostIdx;
      }

      const hostIds = cursor.hostIds || [];
      let hIdx = cursor.hostIdx || 0;

      while (hIdx < hostIds.length) {
        // 预算检查放在处理前：保证当前机处理完才超时退出
        if (Date.now() - startedAt > SCHEDULE_TIME_BUDGET_MS) {
          const saved = await persistPartial(pIdx, hIdx, pname, hostIds.length);
          if (saved < 0) {
            await logBuf.flush(env);
            return {
              skipped: true,
              reason: 'claim_lost',
              needContinue: true,
              config: cfg,
              continueCursor: Object.assign(sanitizeCursorForKv(cursor) || {}, { stats: Object.assign({}, stats) })
            };
          }
          await logBuf.flush(env);
          return await yieldAndPartial();
        }

        const hostId = hostIds[hIdx];
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
              const rec = await serverRecoverHost(cursor.baseUrl, cursor.jwt, hostId, data);
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

        // 本机处理完再推进下标，并立刻写 KV（核心：硬超时也不丢已完成进度）
        hIdx++;
        cursor.hostIdx = hIdx;
        cursor.providerIdx = pIdx;
        try {
          const saved = await persistPartial(pIdx, hIdx, pname, hostIds.length);
          if (saved < 0) {
            await logBuf.flush(env);
            return { skipped: true, reason: 'claim_lost', needContinue: true, config: cfg };
          }
          hIdx = saved;
          cursor.hostIdx = hIdx;
        } catch (kvErr) {
          console.warn('persistPartial failed:', kvErr);
        }

        // 日志缓冲较大时中途 flush，避免丢日志
        if (stats.checked % 3 === 0) {
          await logBuf.flush(env);
        }

        await sleepMs(SCHEDULE_HOST_GAP_MS);
      }

      // 当前服务商完成
      pIdx++;
      cursor = {
        providerIdx: pIdx, hostIdx: 0, hostIds: null, providerId: null,
        jwt: null, baseUrl: null, pname: null, roundId
      };
      cfg.cursor = sanitizeCursorForKv(cursor);
      cfg.stats = stats;
      cfg.running = true;
      cfg.claimToken = claimToken;
      cfg.roundId = roundId;
      cfg.progress = '服务商 ' + pIdx + '/' + providers.length;
      await saveScheduleConfig(env, cfg);
    }

    await logBuf.flush(env);
    return await finishScheduleRound(env, cfg, stats, logBuf, false);
  } catch (e) {
    logBuf.push('error', '巡检异常', e.message);
    await logBuf.flush(env);
    // 异常时尽量保留当前 cursor
    try {
      cfg.cursor = sanitizeCursorForKv(cursor);
      cfg.stats = stats;
      cfg.running = true;
      cfg.lastSummary = '执行异常: ' + e.message;
      await saveScheduleConfig(env, cfg);
    } catch (_) { /* ignore */ }
    return {
      skipped: false,
      success: false,
      error: e.message,
      needContinue: !!(cursor && (cursor.hostIds || cursor.providerIdx > 0)),
      config: cfg,
      continueCursor: cursor ? Object.assign(sanitizeCursorForKv(cursor) || {}, { stats: Object.assign({}, stats) }) : null
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
  cfg.roundId = null;
  cfg.claimToken = null;
  cfg.yielded = false;
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

/**
 * 后台自续跑（关页全量关键路径）：
 * 1) 优先在 waitUntil 内直接循环 executeScheduleRound（不依赖 HTTP 自调用，更可靠）
 * 2) 每跳仍带 bodyCursor 快照；hop 用尽后归零继续，直到本轮完成
 * 3) already_running 时延迟再试，避免关页后无人接棒
 * 4) 额外发 1 次 HTTP continue 作兜底（外部 cron 仍是最终保险）
 */
function scheduleContinueIfNeeded(context, request, result) {
  if (!result || !result.needContinue || !context.waitUntil) return;
  const env = context.env;
  if (!env) return;

  const initialHop = Math.max(0, parseInt(result.hop, 10) || 0);
  let cursorSnap = result.continueCursor || null;
  const isLocked = !!(result.skipped && result.reason === 'already_running');

  context.waitUntil(
    (async () => {
      try {
        // 等本请求 KV 写尽量可见
        await sleepMs(isLocked ? Math.min(SCHEDULE_LOCK_MS, 3000) : 200);

        let hop = initialHop;
        // 后台最多再跑这么多分片；每分片约 16s，CF waitUntil 可能中途截断，截断后靠 cron resume
        const maxLoops = SCHEDULE_CONTINUE_MAX_HOPS;
        for (let i = 0; i < maxLoops; i++) {
          hop = hop + 1;
          // hop 计数仅用于日志；超过上限归零，绝不因 hop 停链
          if (hop > SCHEDULE_CONTINUE_MAX_HOPS) hop = 1;

          let next;
          try {
            next = await executeScheduleRound(env, {
              isContinue: true,
              bodyCursor: cursorSnap,
              hop
            });
          } catch (err) {
            console.warn('schedule bg continue execute error:', err);
            // 失败再试一次 HTTP 兜底
            try {
              await scheduleHttpContinueOnce(request, cursorSnap, hop);
            } catch (_) { /* ignore */ }
            break;
          }

          if (!next) break;

          if (next.continueCursor) cursorSnap = next.continueCursor;

          // 本轮已完成
          if (!next.needContinue) break;

          // 被其他 worker 占用：稍等再抢
          if (next.skipped && next.reason === 'already_running') {
            await sleepMs(Math.min(SCHEDULE_LOCK_MS, 2500));
            continue;
          }

          // claim 丢失：用最新 cursor 再试
          if (next.skipped && next.reason === 'claim_lost') {
            await sleepMs(300);
            continue;
          }

          // 正常 partial：极短间隔进入下一分片
          await sleepMs(150);
        }
      } catch (e) {
        console.warn('scheduleContinueIfNeeded bg loop error:', e);
      }
    })()
  );
}

/** HTTP 自调用 continue 兜底（单次） */
async function scheduleHttpContinueOnce(request, cursor, hop) {
  try {
    const base = new URL(request.url);
    const contUrl = new URL(base.pathname, base.origin);
    contUrl.searchParams.set('continue', '1');
    contUrl.searchParams.set('hop', String(hop || 1));
    await fetch(contUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Schedule-Continue': '1'
      },
      body: JSON.stringify({ cursor: cursor || null, hop: hop || 1 })
    });
  } catch (err) {
    console.warn('scheduleHttpContinueOnce failed:', err);
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
    cfg.roundId = null;
    cfg.claimToken = null;
    cfg.yielded = false;
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
    cfg.roundId = null;
    cfg.claimToken = null;
    cfg.yielded = false;
    await saveScheduleConfig(env, cfg);
    await appendScheduleLog(env, 'info', '定时已停止');
    return jsonResponse({ success: true, msg: '服务端定时已停止', config: cfg });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

/** GET|POST /api/schedule/run  ?force=1 立即执行  ?continue=1 分片续跑  ?new=1 强制新一轮
 *  Body 可选: { cursor, hop } — waitUntil 续跑时携带进度快照
 */
async function handleScheduleRun(context) {
  const { request, env } = context;
  if (!env.AUTH_KV) {
    return jsonResponse({ success: false, error: 'KV 存储未配置' }, 500);
  }
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
    const forceNew = url.searchParams.get('new') === '1' || url.searchParams.get('new') === 'true';
    let isContinue = url.searchParams.get('continue') === '1' || url.searchParams.get('continue') === 'true';
    if (request.headers.get('X-Schedule-Continue') === '1') isContinue = true;
    let hop = parseInt(url.searchParams.get('hop') || '0', 10) || 0;

    let bodyCursor = null;
    if (request.method === 'POST' || request.method === 'PUT') {
      try {
        const body = await request.json();
        if (body && body.cursor && typeof body.cursor === 'object') {
          bodyCursor = body.cursor;
          isContinue = true;
        }
        if (body && body.hop != null) hop = parseInt(body.hop, 10) || hop;
      } catch { /* empty / non-json body ok */ }
    }

    const result = await executeScheduleRound(env, { force, forceNew, isContinue, bodyCursor, hop });
    scheduleContinueIfNeeded(context, request, result);
    // 响应里带上 continueCursor，方便前端盯梢时回传
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