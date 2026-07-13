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