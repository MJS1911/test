/**
 * Cloudflare Pages Function - API 代理 + 认证存储
 * 替代本地 proxy.js，部署到 Cloudflare Pages Functions 后自动生效
 * 路由: /api/* -> 代理到目标魔方财务 API
 * 路由: /api/auth/save -> 保存登录凭证到 KV
 * 路由: /api/auth/load -> 从 KV 读取登录凭证
 * 路由: /api/auth/clear -> 清除 KV 中的登录凭证
 * 路由: /api/admin/verify -> 验证管理密码
 * 路由: /api/admin/change -> 修改管理密码
 * 路由: /api/admin/check -> 检查是否已验证管理密码
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
  
  // ========== /api/admin/* 路由：管理密码验证 ==========
  if (path === '/admin/verify' || path === '/admin/verify/') {
    return handleAdminVerify(context);
  }
  if (path === '/admin/change' || path === '/admin/change/') {
    return handleAdminChange(context);
  }
  if (path === '/admin/check' || path === '/admin/check/') {
    return handleAdminCheck(context);
  }
  
  // ========== 常规 API 代理转发 ==========
  // 从 KV 读取用户配置的 baseUrl（登录时保存），支持多平台切换
  // 优先级: KV存储的用户配置 > 环境变量 API_BASE_URL > 默认值
  let targetApiBase = env.API_BASE_URL || 'https://www.heyunidc.cn/v1/';
  let provisionApiBase = 'https://www.heyunidc.cn/';
  
  if (env.AUTH_KV) {
    try {
      const authRaw = await env.AUTH_KV.get('auth_credentials');
      if (authRaw) {
        const authData = JSON.parse(authRaw);
        if (authData.baseUrl) {
          // 用户配置了 baseUrl，用它来推导目标地址
          targetApiBase = authData.baseUrl;
          // 从 baseUrl 推导 provision 基础地址（去掉路径部分，只保留协议+域名）
          // 例如: https://www.heyunidc.cn/v1/ -> https://www.heyunidc.cn/
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

// ==================== 管理密码管理 ====================

/**
 * 默认管理密码
 */
const DEFAULT_ADMIN_PASSWORD = '1234560';

/**
 * 获取管理密码（从 KV 读取，不存在则返回默认值）
 */
async function getAdminPassword(env) {
  if (!env.AUTH_KV) {
    return DEFAULT_ADMIN_PASSWORD;
  }
  try {
    const raw = await env.AUTH_KV.get('admin_password');
    return raw || DEFAULT_ADMIN_PASSWORD;
  } catch {
    return DEFAULT_ADMIN_PASSWORD;
  }
}

/**
 * 设置管理密码（存储到 KV）
 */
async function setAdminPassword(env, password) {
  if (!env.AUTH_KV) {
    throw new Error('KV 存储未配置');
  }
  await env.AUTH_KV.put('admin_password', password);
}

/**
 * 验证管理密码
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

    const storedPassword = await getAdminPassword(env);
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
 * 修改管理密码
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

    const storedPassword = await getAdminPassword(env);
    if (oldPassword !== storedPassword) {
      return new Response(JSON.stringify({ success: false, error: '原密码错误' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    await setAdminPassword(env, newPassword);

    return new Response(JSON.stringify({ success: true, msg: '管理密码修改成功' }), {
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
  const { request, env } = context;

  // 从 Cookie 中读取 admin_verified 标记
  const cookieHeader = request.headers.get('Cookie') || '';
  const verified = cookieHeader.includes('admin_verified=true');

  return new Response(JSON.stringify({ success: true, verified }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
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