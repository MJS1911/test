# 关页定时触发器（Cloudflare Worker Cron）

与参考项目 [heyun-zjmf-worker-monitor](https://github.com/SadB0ymjs/heyun-zjmf-worker-monitor) 相同机制：

- **Cloudflare Worker** 注册 `scheduled` + `crons = ["* * * * *"]`
- 平台每分钟唤醒 Worker（**不依赖浏览器**）
- Worker 再 `POST` 你的 Pages 站点 `/api/schedule/run`
- Pages 侧分片 + `waitUntil` 负责跑完全部机器

Pages 本身没有 Cron Trigger，所以需要这个独立 Worker 当「闹钟」。

## 一键部署

```powershell
cd cron-worker
npx wrangler login
npx wrangler secret put TARGET_URL
# 粘贴你的 Pages 地址，例如：https://xxx.pages.dev（不要末尾斜杠）
npx wrangler deploy
```

部署成功后，Worker 每分钟自动触发；也可浏览器打开 Worker 地址 `/run` 手动测一次。

## 可选：GitHub Actions 兜底

仓库已带 `.github/workflows/schedule-cron.yml`。在 GitHub 仓库 **Settings → Secrets → Actions** 添加：

| Secret | 值 |
|--------|-----|
| `PAGES_URL` | `https://xxx.pages.dev` |

与 cron-worker 二选一或同时用均可。**优先推荐 cron-worker**（纯 CF 内闭环，延迟更稳）。

## 验证

1. 面板点「启动定时」
2. 关掉浏览器
3. 等 1～2 分钟后重新打开，看「定时操作」状态与日志是否有新一轮巡检
4. 或在 Cloudflare Dashboard → Workers → `mf-schedule-cron` → Logs 查看触发记录