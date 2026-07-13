/**
 * mf-schedule-cron — Cloudflare Worker Cron Trigger
 *
 * 参考 heyun-zjmf-worker-monitor 的 scheduled() 实现：
 * 平台按 cron 表达式唤醒本 Worker，再请求 Pages 的 /api/schedule/run。
 * 关浏览器后仍会到点巡检；Pages 侧分片 + waitUntil 负责跑完全部机器。
 *
 * Secrets:
 *   TARGET_URL  - 必填，Pages 站点根地址，如 https://xxx.pages.dev
 *   CRON_SECRET - 可选，与 Pages 环境变量 CRON_SECRET 一致时带 X-Cron-Secret
 */

function buildRunUrl(targetUrl) {
  const base = String(targetUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return base + '/api/schedule/run';
}

async function triggerScheduleRun(env) {
  const runUrl = buildRunUrl(env.TARGET_URL);
  if (!runUrl) {
    console.error('[mf-schedule-cron] TARGET_URL 未配置，跳过');
    return { ok: false, error: 'TARGET_URL missing' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'mf-schedule-cron/1.0',
    'X-Schedule-Cron': '1'
  };
  if (env.CRON_SECRET) {
    headers['X-Cron-Secret'] = env.CRON_SECRET;
  }

  try {
    const resp = await fetch(runUrl, {
      method: 'POST',
      headers,
      body: '{}'
    });
    const text = await resp.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    console.log(
      '[mf-schedule-cron]',
      resp.status,
      body && body.skipped ? 'skipped:' + (body.reason || '') : '',
      body && body.needContinue ? 'needContinue' : '',
      body && body.config && body.config.progress
        ? JSON.stringify(body.config.progress)
        : ''
    );
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    console.error('[mf-schedule-cron] fetch failed:', err && err.message);
    return { ok: false, error: String(err && err.message || err) };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 手动探测：GET / 或 /run 立即触发一次
    if (url.pathname === '/run' || url.pathname === '/') {
      const result = await triggerScheduleRun(env);
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
    return new Response(
      JSON.stringify({
        service: 'mf-schedule-cron',
        hint: 'GET /run 手动触发；Cron 每分钟自动 POST TARGET_URL/api/schedule/run'
      }),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(triggerScheduleRun(env));
  }
};