# 魔方财务服务器管理面板 - Cloudflare Pages 部署版

> **一键部署到 Cloudflare Pages，无需本地代理，开箱即用**

这是一个基于 Cloudflare Pages + Functions 的魔方财务服务器管理面板。前端静态文件部署在 Cloudflare Pages，API 请求通过 Cloudflare Functions 代理转发到目标魔方财务站点，完美解决 CORS 跨域、Cookie 认证、Referer/Origin 校验等问题。

---

## 📁 项目结构

```
html2/
├── index.html              # 主页面
├── css/
│   └── style.css           # 样式文件
├── js/
│   ├── api.js              # API 客户端 (Cloudflare Pages 版)
│   ├── ui.js               # 界面交互逻辑
│   └── operations.js       # 操作执行与状态轮询
├── functions/
│   └── api/
│       └── [[path]].js     # Cloudflare Function - API 代理核心
└── README.md               # 本文档
```

---

## 🚀 核心优势

| 特性 | 传统本地版 (html/) | Cloudflare Pages 版 (html2/) |
|------|-------------------|------------------------------|
| **部署方式** | 本地运行需启动 Node.js 代理 | 一键部署到 Cloudflare，全球 CDN 加速 |
| **跨域问题** | 需本地代理解决 CORS | Functions 自动添加 CORS 头，无跨域问题 |
| **Cookie 认证** | 代理手动转换 JWT→Cookie | Functions 自动从 Authorization 提取 JWT 设置 Cookie |
| **Referer/Origin 校验** | 代理手动设置 | Functions 自动设置为目标域名 |
| **HTTPS** | 本地需配置证书 | Cloudflare 自动提供 HTTPS |
| **访问速度** | 受限于本地网络 | Cloudflare 全球边缘节点，毫秒级响应 |
| **维护成本** | 需长期运行本地服务 | 完全托管，零运维 |

---

## 📋 部署前准备

### 1. 注册 Cloudflare 账号
- 访问 [dash.cloudflare.com](https://dash.cloudflare.com) 注册/登录
- 免费套餐即可满足需求（Pages 免费额度：500 次构建/月，无限请求）

### 2. 准备目标魔方财务站点信息
你需要知道目标站点的 API 基础地址，例如：
- `https://www.heyunidc.cn/v1/`
- `https://your-domain.com/v1/`

> ⚠️ **重要**：目标站点必须支持魔方财务标准 API（`/v1/login_api`、`/v1/hosts`、`/provision/default` 等）

### 3. 获取 API 密钥
- 登录目标魔方财务用户中心
- 进入「API 设置」或「开发者设置」
- 生成/查看 **API Key**（不是登录密码）

### 4. 创建 KV Namespace（用于持久化存储登录凭证）
**这一步是实现「登录后自动保存、下次打开自动填充」的关键！**

1. 登录 Cloudflare Dashboard
2. 左侧菜单选择 **Workers & Pages** → **KV**
3. 点击 **创建命名空间**
4. 命名为 `mf-server-panel-auth`（或任意名称）
5. 记下生成的 **命名空间 ID**（格式如：`abc123def456...`）

> 💡 免费套餐包含 1 个 KV 命名空间，1GB 存储，每天 10 万次读取，1 万次写入，完全够用

---

## 🛠️ 部署步骤（详细版）

### 方法一：通过 Git 仓库部署（推荐，支持自动构建）

#### 步骤 1：创建 Git 仓库
```bash
# 在本地 html2 目录下初始化 Git
cd html2
git init
git add .
git commit -m "Initial commit: Cloudflare Pages version with KV auth storage"
```

#### 步骤 2：推送到 GitHub/GitLab
```bash
# 在 GitHub 创建新仓库（公开或私有均可）
# 然后关联并推送
git remote add origin https://github.com/你的用户名/你的仓库名.git
git branch -M main
git push -u origin main
```

#### 步骤 3：在 Cloudflare Pages 创建项目
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单选择 **Workers & Pages** → **Pages** → **创建项目**
3. 选择 **连接到 Git** → 选择 **GitHub**（或 GitLab）
4. 授权 Cloudflare 访问你的仓库
5. 选择刚创建的仓库 → **开始设置**

#### 步骤 4：配置构建设置
| 设置项 | 值 |
|--------|-----|
| **项目名称** | 你的项目名（如 `mf-server-panel`） |
| **生产分支** | `main` |
| **构建命令** | 留空（静态站点无需构建） |
| **构建输出目录** | `/`（根目录） |
| **根目录** | `/` |

> ⚠️ **关键**：因为是纯静态站点，**构建命令留空**，**输出目录填 `/`**

#### 步骤 5：添加环境变量（关键步骤！）
在 **设置** → **环境变量** 中添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `API_BASE_URL` | `https://www.heyunidc.cn/v1/` | 目标魔方财务 API 基础地址，**必须以 `/v1/` 结尾** |

#### 步骤 6：绑定 KV Namespace（实现持久化登录）
在 **设置** → **Functions** → **KV 命名空间绑定** 中添加：

| 变量名 | KV 命名空间 |
|--------|-------------|
| `AUTH_KV` | 选择步骤 4 创建的 `mf-server-panel-auth` |

> 💡 绑定后，Functions 代码中通过 `env.AUTH_KV` 访问 KV，实现登录凭证的云端存储

#### 步骤 7：部署
点击 **保存并部署**，等待构建完成（通常 1-2 分钟）。
部署成功后，你会获得一个 `https://<项目名>.pages.dev` 的访问地址。

---

### 方法二：直接上传文件部署（无需 Git）

#### 步骤 1：打包文件
将 `html2` 文件夹内的所有文件压缩为 ZIP：
```
html2.zip
├── index.html
├── css/style.css
├── js/api.js
├── js/ui.js
├── js/operations.js
└── functions/api/[[path]].js
```

#### 步骤 2：上传部署
1. Cloudflare Dashboard → **Workers & Pages** → **Pages** → **创建项目**
2. 选择 **直接上传** → **上传资产**
3. 项目名称填写 → 拖拽上传 `html2.zip`
4. 点击 **部署站点**

#### 步骤 3：配置环境变量
部署完成后，进入项目 **设置** → **环境变量**，添加：
- `API_BASE_URL` = `https://www.heyunidc.cn/v1/`

#### 步骤 4：绑定 KV Namespace
进入项目 **设置** → **Functions** → **KV 命名空间绑定**，添加：
- 变量名：`AUTH_KV`
- KV 命名空间：选择创建的 `mf-server-panel-auth`

#### 步骤 5：重新部署
环境变量和 KV 绑定修改后必须重新部署才能生效：
- **部署** 标签页 → **重新部署** → 选择最新提交 → **部署**

---

## ⚙️ 进阶配置

### 自定义域名
1. Pages 项目 → **自定义域名** → **设置自定义域名**
2. 输入你的域名（如 `panel.yourdomain.com`）
3. 按提示添加 DNS 记录（CNAME 指向 `<项目名>.pages.dev`）
4. 等待 SSL 证书自动签发（通常几分钟）

### Wrangler CLI 本地开发/部署
```bash
# 安装 Wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 本地开发预览（在 html2 目录下）
wrangler pages dev . --binding API_BASE_URL=https://www.heyunidc.cn/v1/ --kv AUTH_KV

# 直接部署（无需 Git）
wrangler pages deploy . --project-name=mf-server-panel --branch=main
```

### 环境变量配置文件 (wrangler.toml)
在 `html2` 目录创建 `wrangler.toml`：
```toml
name = "mf-server-panel"
compatibility_date = "2024-01-01"
pages_build_output_dir = "."

[vars]
API_BASE_URL = "https://www.heyunidc.cn/v1/"

# KV 绑定（本地开发时使用）
[[kv_namespaces]]
binding = "AUTH_KV"
id = "你的KV命名空间ID"
preview_id = "你的预览环境KV命名空间ID"

# 预览环境变量
[env.preview.vars]
API_BASE_URL = "https://preview.heyunidc.cn/v1/"
```

---

## 🔧 使用指南

### 1. 访问面板
打开部署后的地址：`https://<项目名>.pages.dev`

### 2. 配置登录信息
| 字段 | 说明 | 示例 |
|------|------|------|
| **目标站点** | 显示用，实际请求走 `/api/*` | `https://www.heyunidc.cn/v1/` |
| **账号** | 魔方财务用户中心登录账号（手机/邮箱） | `13800138000` |
| **API 密钥** | 用户中心生成的 API Key，**不是登录密码** | `sk_xxxxxxxxxxxxx` |

### 3. 功能操作
- **登录**：点击「🔓 登录」，成功后自动加载服务器列表
- **查询状态**：点击表格中「📊」按钮查询单台服务器电源状态
- **单台操作**：▶️开机 ⏹️关机 🔄重启 ⚡硬重启
- **批量操作**：左侧面板「全部开机/关机/重启/硬重启/硬关机/刷新状态」
- **系统日志**：底部日志面板显示所有 API 请求详情，可收起/清空

### 4. 二次验证处理
部分操作（如重装系统）可能触发二次验证：
1. 操作时弹出「二次验证」弹窗
2. 选择验证方式（邮箱/短信）
3. 点击「发送验证码」
4. **前往原网站用户中心完成验证**
5. 验证通过后重新执行操作

---

## 🐛 常见问题排查

### Q1: 登录失败 "网络请求失败"
**原因**：目标站点 API 地址错误、网络不通、或 API 接口不兼容
**排查**：
- 检查 `API_BASE_URL` 环境变量是否正确（必须以 `/v1/` 结尾）
- 浏览器 F12 Network 面板查看 `/api/login_api` 请求详情
- 确认目标站点支持 `/v1/login_api` 接口

### Q2: 获取服务器列表为空/报错
**原因**：JWT 过期、API 接口路径变更、权限不足
**排查**：
- 重新登录获取新 JWT
- 检查 `/api/hosts` 请求返回内容
- 确认账号有服务器查看权限

### Q3: 操作（开机/关机）无响应或报错
**原因**：
- Provision 接口需要 Cookie 认证（Functions 已自动处理）
- Referer/Origin 校验失败（Functions 已自动设置为目标域名）
- 目标站点 provision 接口路径非标准
**排查**：
- 查看浏览器控制台日志（F12 Console）
- 底部日志面板查看详细请求/响应
- 确认目标站点 `/provision/default` 接口正常

### Q4: CORS 错误
**现象**：控制台报 `Access-Control-Allow-Origin` 错误
**原因**：Functions 未正确部署或环境变量未生效
**解决**：
- 确认 `functions/api/[[path]].js` 文件存在
- 重新部署（环境变量修改后必须重新部署）
- 检查 Functions 日志：Pages 项目 → **Functions** → **日志**

### Q5: 部署后页面空白/样式丢失
**原因**：文件路径错误、构建输出目录配置错误
**解决**：
- 确认 `index.html` 在根目录
- 构建输出目录设为 `/`
- 检查浏览器 Network 面板是否有 404 资源

### Q6: 登录凭证没有自动保存/下次打开没有自动填充
**原因**：KV 命名空间未绑定或绑定变量名错误
**解决**：
- 确认已在 Cloudflare Pages 设置中创建并绑定 KV 命名空间
- 绑定变量名必须为 `AUTH_KV`（大小写敏感）
- 绑定后需要**重新部署**才能生效
- 检查 Functions 日志中是否有 KV 相关错误
- 如果 KV 未配置，不影响正常登录使用，只是没有自动保存功能

---

## 📝 关键技术原理

### Cloudflare Functions 代理工作流程
```
浏览器请求 /api/hosts
    ↓
Cloudflare Functions (functions/api/[[path]].js)
    ↓ 1. 读取环境变量 API_BASE_URL
    ↓ 2. 从 Authorization: Bearer <jwt> 提取 JWT
    ↓ 3. 设置 Cookie: ZJMF_8F073A284ADDCA6A=<jwt>
    ↓ 4. 设置 Origin/Referer = 目标域名
    ↓ 5. 转发请求到 https://目标域名/v1/hosts
    ↓
目标魔方财务 API 返回数据
    ↓
Functions 添加 CORS 头返回给浏览器
    ↓
浏览器接收响应，渲染页面
```

### KV 认证存储工作流程
```
用户登录成功
    ↓
前端调用 /api/auth/save (POST { account, apiKey, baseUrl })
    ↓
Functions 写入 KV: key="auth_credentials", value=JSON(凭证)
    ↓
下次打开页面
    ↓
前端调用 /api/auth/load (GET)
    ↓
Functions 从 KV 读取凭证返回
    ↓
自动填充表单，用户可直接点击登录
    ↓
用户登出
    ↓
前端调用 /api/auth/clear (POST)
    ↓
Functions 从 KV 删除凭证
```

### 为什么需要 Functions 代理？
魔方财务 `/provision/default` 接口有三重限制：
1. **CORS 跨域限制** - 浏览器直接请求会被拦截
2. **Cookie 认证** - 必须携带 `ZJMF_8F073A284ADDCA6A=<jwt>` Cookie
3. **Referer/Origin 校验** - 必须来自目标域名的页面

本地版通过 Node.js 代理 (proxy.js) 解决，Cloudflare Pages 版通过 Functions 在边缘节点解决，**无需本地运行任何服务**。

---

## 🔒 安全建议

1. **API Key 保密**：不要在前端代码硬编码 API Key，通过登录界面输入
2. **环境变量保护**：`API_BASE_URL` 在 Cloudflare Dashboard 设置，不提交到代码仓库
3. **HTTPS 强制**：Cloudflare Pages 自动强制 HTTPS，无需额外配置
4. **访问限制**：如需限制访问，可在 Cloudflare Zero Trust 配置访问策略

---

## 📚 相关文件说明

| 文件 | 作用 | 修改建议 |
|------|------|----------|
| `functions/api/[[path]].js` | 核心代理逻辑 + KV 认证存储 | 如目标站点接口路径不同，修改此处转发逻辑；KV 绑定变量名需与 Pages 设置一致 |
| `js/api.js` | 前端 API 客户端 | 如需新增接口，在此添加对应函数 |
| `js/ui.js` | 界面渲染交互 | 如需调整 UI，修改此处 |
| `js/operations.js` | 操作执行逻辑 | 如需新增操作类型，修改 `OPERATION_MAP` |
| `css/style.css` | 样式 | 如需调整外观，修改此处 |

---

## 🤝 贡献与扩展

### 新增 API 接口
1. 在 `js/api.js` 添加请求函数
2. 在 `functions/api/[[path]].js` 确认转发路径正确
3. 在 `js/ui.js` / `js/operations.js` 添加调用逻辑

### 适配其他魔方财务站点
只需修改 `API_BASE_URL` 环境变量即可，前端代码无需改动。

### 添加持久化存储
可结合 Cloudflare KV 或 D1 数据库存储：
- 服务器列表缓存
- 用户偏好设置
- 操作历史记录

---

## 📄 许可证

MIT License - 可自由使用、修改、分发

---

## 🙏 致谢

- [Cloudflare Pages](https://pages.cloudflare.com/) - 免费静态托管 + Functions
- [魔方财务](https://www.mfcz.com/) - 提供标准 API 接口
- 原项目 `html/` 版本的本地代理设计思路

---

## 📞 技术支持

如遇部署问题，请检查：
1. Cloudflare Pages **Functions 日志**（实时查看代理请求详情）
2. 浏览器 **开发者工具 Console/Network** 面板
3. 本文档「常见问题排查」章节

> **提示**：Functions 日志在 Cloudflare Dashboard → Workers & Pages → 你的项目 → Functions → 日志 中查看，支持实时流式输出，是调试代理问题的最佳工具。