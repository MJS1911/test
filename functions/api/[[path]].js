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
//   schedule_config  - { enabled, intervalMin, lastRunAt, nextRunAt, running, lastSummary, updatedAt }
//   schedule_logs    - [{ ts, level, msg, detail? }, ...] 最多 100 条
//
// 触发方式（任选其一，推荐 1）：
// 1. Cloudflare Cron Triggers 每分钟打 GET/POST /api/schedule/run（内部按 intervalMin 判断是否执行）
// 2. 外部 cron（如 cron-job.org）每分钟请求 https://你的站点.pages.dev/api/schedule/run
// 3. 前端打开时也会轮询 status；手动可 POST /api/schedule/run?force=1 立即跑一轮

const SCHEDULE_CONFIG_KEY = 'schedule_config';
const SCHEDULE_LOGS_KEY = 'schedule_logs';
const SCHEDULE_MAX_LOGS = 100;
const SCHEDULE_DEFAULT_INTERVAL = 5;
const SCHEDULE_MIN_INTERVAL = 1;
const SCHEDULE_MAX_INTERVAL = 1440;

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
    updatedAt: null
  };
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

async function appendScheduleLog(env, level, msg, detail) {
  if (!env.AUTH_KV) return;
  try {
    const logs = await getScheduleLogs(env);
    logs.unshift({
      ts: new Date().toISOString(),
      level: level || 'info',
      msg: String(msg || ''),
      detail: detail != null ? String(detail).substring(0, 500) : undefined
    });
    while (logs.length > SCHEDULE_MAX_LOGS) logs.pop();
    await env.AUTH_KV.put(SCHEDULE_LOGS_KEY, JSON.stringify(logs));
  } catch (e) {
    console.warn('appendScheduleLog failed:', e);
  }
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
  const loginData = await loginResp.json();

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
  return s === 'on' || s === 'running' || s === 'online';
}

async function serverRecoverHost(providerBase, jwt, hostId) {
  // 优先硬重启
  const hardParams = new URLSearchParams();
  hardParams.append('id', String(hostId));
  hardParams.append('func', 'hard_reboot');
  try {
    const hard = await serverApiRequest(providerBase, jwt, 'provision/default', 'POST', hardParams.toString(), true);
    if (hard && hard.status === 200 && !(hard.data && hard.data._second_verify)) {
      return { success: true, action: 'hard_reboot', msg: hard.msg || '硬重启成功' };
    }
  } catch (e) {
    // fall through
  }
  // 兜底普通重启
  const softParams = new URLSearchParams();
  softParams.append('id', String(hostId));
  softParams.append('func', 'reboot');
  try {
    const soft = await serverApiRequest(providerBase, jwt, 'provision/default', 'POST', softParams.toString(), true);
    if (soft && soft.status === 200 && !(soft.data && soft.data._second_verify)) {
      return { success: true, action: 'reboot', msg: soft.msg || '重启成功' };
    }
    return {
      success: false,
      action: 'reboot',
      error: (soft && (soft.msg || soft.info)) || '重启失败'
    };
  } catch (e) {
    return { success: false, action: 'reboot', error: e.message };
  }
}

/**
 * 执行一轮：遍历所有服务商 → 登录 → 拉 hosts → 查 status → 非运行则 hard_reboot→reboot
 */
async function executeScheduleRound(env, options = {}) {
  const force = !!options.force;
  let cfg = await getScheduleConfig(env);

  if (!cfg.enabled && !force) {
    return { skipped: true, reason: 'disabled', config: cfg };
  }

  // 未到下次执行时间则跳过（force 除外）
  if (!force && cfg.nextRunAt) {
    const next = new Date(cfg.nextRunAt).getTime();
    if (!isNaN(next) && Date.now() < next - 2000) {
      return { skipped: true, reason: 'not_due', config: cfg, nextRunAt: cfg.nextRunAt };
    }
  }

  // 防并发：若标记 running 且 10 分钟内，跳过
  if (cfg.running && cfg.updatedAt) {
    const updated = new Date(cfg.updatedAt).getTime();
    if (!isNaN(updated) && Date.now() - updated < 10 * 60 * 1000) {
      return { skipped: true, reason: 'already_running', config: cfg };
    }
  }

  cfg.running = true;
  await saveScheduleConfig(env, cfg);
  await appendScheduleLog(env, 'info', '开始巡检', 'interval=' + cfg.intervalMin + 'min');

  const providers = await getProviders(env);
  let totalChecked = 0, totalRunning = 0, totalRecovered = 0, totalFailed = 0;
  const providerResults = [];

  try {
    if (!providers || providers.length === 0) {
      await appendScheduleLog(env, 'warning', '无服务商，跳过');
    }

    for (const provider of providers || []) {
      const pname = provider.name || provider.id || 'unknown';
      const pResult = { id: provider.id, name: pname, checked: 0, running: 0, recovered: 0, failed: 0, error: null };

      try {
        if (!provider.account || !provider.apiKey) {
          pResult.error = '缺少登录凭证';
          await appendScheduleLog(env, 'warning', '[' + pname + '] 缺少凭证，跳过');
          providerResults.push(pResult);
          continue;
        }

        const login = await serverLoginProvider(provider);
        if (!login.ok) {
          pResult.error = login.error;
          totalFailed++;
          await appendScheduleLog(env, 'error', '[' + pname + '] 登录失败', login.error);
          providerResults.push(pResult);
          continue;
        }

        // 拉服务器列表
        const hostsResp = await serverApiRequest(login.baseUrl, login.jwt, 'hosts?page=1&limit=200', 'GET', null, false);
        if (!hostsResp || hostsResp.status !== 200) {
          pResult.error = (hostsResp && (hostsResp.msg || hostsResp.info)) || '获取服务器列表失败';
          totalFailed++;
          await appendScheduleLog(env, 'error', '[' + pname + '] 获取列表失败', pResult.error);
          providerResults.push(pResult);
          continue;
        }

        const hosts = (hostsResp.data && hostsResp.data.host) || [];
        await appendScheduleLog(env, 'info', '[' + pname + '] 开始检查', '共 ' + hosts.length + ' 台');

        for (const host of hosts) {
          const hostId = host.id;
          if (!hostId) continue;
          try {
            const stParams = new URLSearchParams();
            stParams.append('id', String(hostId));
            stParams.append('func', 'status');
            const st = await serverApiRequest(login.baseUrl, login.jwt, 'provision/default', 'POST', stParams.toString(), true);

            if (st && st.status === 200) {
              pResult.checked++;
              totalChecked++;
              const data = st.data || {};
              if (isHostRunningStatus(data)) {
                pResult.running++;
                totalRunning++;
              } else {
                const des = data.des || data.status || '非运行中';
                await appendScheduleLog(env, 'warning', '[' + pname + '] #' + hostId + ' 非运行中 (' + des + ')，尝试恢复');
                const rec = await serverRecoverHost(login.baseUrl, login.jwt, hostId);
                if (rec.success) {
                  pResult.recovered++;
                  totalRecovered++;
                  await appendScheduleLog(env, 'success', '[' + pname + '] #' + hostId + ' ' + rec.action + ' 成功', rec.msg);
                } else {
                  pResult.failed++;
                  totalFailed++;
                  await appendScheduleLog(env, 'error', '[' + pname + '] #' + hostId + ' 恢复失败', rec.error);
                }
              }
            } else {
              pResult.failed++;
              totalFailed++;
              const err = (st && (st.msg || st.info)) || '查状态失败';
              await appendScheduleLog(env, 'error', '[' + pname + '] #' + hostId + ' 查状态失败', err);
            }
          } catch (hostErr) {
            pResult.failed++;
            totalFailed++;
            await appendScheduleLog(env, 'error', '[' + pname + '] #' + hostId + ' 异常', hostErr.message);
          }
          // 轻微间隔，避免打爆目标站
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (pErr) {
        pResult.error = pErr.message;
        totalFailed++;
        await appendScheduleLog(env, 'error', '[' + pname + '] 异常', pErr.message);
      }
      providerResults.push(pResult);
    }

    const summary = '检查 ' + totalChecked + ' · 运行中 ' + totalRunning + ' · 已恢复 ' + totalRecovered + ' · 失败 ' + totalFailed;
    const now = new Date();
    const intervalMin = Math.max(SCHEDULE_MIN_INTERVAL, Math.min(SCHEDULE_MAX_INTERVAL, cfg.intervalMin || SCHEDULE_DEFAULT_INTERVAL));
    cfg = await getScheduleConfig(env); // 重新读，避免覆盖用户中途 stop
    cfg.running = false;
    cfg.lastRunAt = now.toISOString();
    cfg.lastSummary = summary;
    if (cfg.enabled) {
      cfg.nextRunAt = new Date(now.getTime() + intervalMin * 60 * 1000).toISOString();
    } else {
      cfg.nextRunAt = null;
    }
    await saveScheduleConfig(env, cfg);
    await appendScheduleLog(env, 'info', '本轮完成', summary);

    return {
      skipped: false,
      success: true,
      summary,
      stats: { checked: totalChecked, running: totalRunning, recovered: totalRecovered, failed: totalFailed },
      providers: providerResults,
      config: cfg
    };
  } catch (e) {
    cfg = await getScheduleConfig(env);
    cfg.running = false;
    cfg.lastSummary = '执行异常: ' + e.message;
    await saveScheduleConfig(env, cfg);
    await appendScheduleLog(env, 'error', '巡检异常', e.message);
    return { skipped: false, success: false, error: e.message, config: cfg };
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
    return jsonResponse({ success: true, config, logs: logs.slice(0, 20) });
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
    cfg.nextRunAt = new Date().toISOString(); // 立即到期，下次 run 会执行
    cfg.running = false;
    await saveScheduleConfig(env, cfg);
    await appendScheduleLog(env, 'info', '定时已启动', '间隔 ' + intervalMin + ' 分钟，覆盖全部服务商');

    // 启动时立即跑一轮（waitUntil 若可用则后台，否则同步）
    let runResult = null;
    try {
      if (context.waitUntil) {
        context.waitUntil(executeScheduleRound(env, { force: true }));
        runResult = { deferred: true };
      } else {
        runResult = await executeScheduleRound(env, { force: true });
      }
    } catch (runErr) {
      console.warn('schedule start immediate run error:', runErr);
    }

    cfg = await getScheduleConfig(env);
    return jsonResponse({
      success: true,
      msg: '服务端定时已启动，关闭网页后仍会按间隔巡检全部服务商',
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
    await saveScheduleConfig(env, cfg);
    await appendScheduleLog(env, 'info', '定时已停止');
    return jsonResponse({ success: true, msg: '服务端定时已停止', config: cfg });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

/** GET|POST /api/schedule/run  ?force=1 立即执行 */
async function handleScheduleRun(context) {
  const { request, env } = context;
  if (!env.AUTH_KV) {
    return jsonResponse({ success: false, error: 'KV 存储未配置' }, 500);
  }
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
    const result = await executeScheduleRound(env, { force });
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