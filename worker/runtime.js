/** Canvas Weekly Hub v2.2 · 网页与只读代理。普通请求不保存凭证；无作者数据接收端。
 * 云端订阅、KV 配置与微信推送暂时停用，仅保留旧订阅清理接口。
 * 修改后运行 python web/build_web.py，部署生成的 worker.js。
 */
const CANVAS_HOST_DEFAULT = "canvas.cityu.edu.hk";
// 保留兼容 UA；403 仍需按响应区分学校权限与防护页，不绕过学校权限。
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Canvas-Token, X-Canvas-Host",
  "Access-Control-Expose-Headers": "Link, X-Canvas-Pagination",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}

function workerInfo(env) {
  return { name: "canvas-weekly-hub proxy", ok: true, version: "2.2",
    capabilities: { proxy: true, integrated: true, subscriptions: false },
    endpoints: ["/health", "/proxy/*", "/unsubscribe", "/overview"] };
}

async function servePage(body, headOnly) {
  const hashes = await Promise.all([...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(async (m) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1]));
    return "'sha256-" + btoa(String.fromCharCode(...new Uint8Array(digest))) + "'";
  }));
  return new Response(headOnly ? null : body, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src " + (hashes.join(" ") || "'none'") +
      "; connect-src 'self' https://api.github.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  } });
}

function canvasHost(value) {
  const host = String(value || "").toLowerCase();
  if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) ||
      /\.(?:localhost|local|internal|test)$/.test(host)) throw new Error("Canvas 地址必须是公开的 HTTPS 学校域名，不含端口或路径");
  return host;
}

function canvasToken(value) {
  const token = String(value || "");
  if (!token || token.length > 4096 || /\s/.test(token)) throw new Error("Canvas 令牌为空或格式错误");
  return token;
}

const READ_PATH = /^(?:users\/self|courses|announcements|courses\/\d+\/(?:assignments|files))(?:\.json)?$/;

async function handleProxy(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/proxy\/?/, "");
  if (!path) return json({ error: "缺少 API 路径，例如 /proxy/courses" }, 400);
  const token = request.headers.get("X-Canvas-Token") || "";
  const host = request.headers.get("X-Canvas-Host") || env.CANVAS_HOST || CANVAS_HOST_DEFAULT;
  if (!READ_PATH.test(path)) return json({ error: "仅支持课程相关查询接口" }, 400);
  if ([...url.searchParams.keys()].some((k) => /^(?:access_token|token|authorization)$/i.test(k)))
    return json({ error: "凭证只能通过请求头传递" }, 400);
  if (path.replace(/\.json$/, "") === "announcements") {
    const contexts = url.searchParams.getAll("context_codes[]");
    if (contexts.length !== 1 || !/^course_\d+$/.test(contexts[0]))
      return json({ error: "公告查询必须指定一个课程，以隔离课程权限失败" }, 400);
  }
  let safeHost, safeToken;
  try { safeHost = canvasHost(host); safeToken = canvasToken(token); }
  catch (e) { return json({ error: e.message }, 400); }
  const target = `https://${safeHost}/api/v1/${path}${url.search}`;
  const r = await fetch(target, {
    redirect: "manual",
    headers: { Authorization: `Bearer ${safeToken}`, Accept: "application/json",
               "User-Agent": BROWSER_UA },
  });
  if (r.status >= 300 && r.status < 400) return json({ error: "Canvas 返回重定向，未向其他地址传递令牌；请核对学校地址" }, 502);
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("Content-Type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store", "X-Canvas-Pagination": "link",
      ...(r.headers.has("Link") ? { Link: r.headers.get("Link") } : {}), ...CORS },
  });
}

async function handleUnsubscribe(request, env) {
  if (!env.HUB_KV) return json({ error: "未绑定 KV 存储" }, 501);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "请求体不是合法 JSON" }, 400); }
  const secret = String(body && body.secret || "");
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(secret)) return json({ error: "订阅密钥无效" }, 400);
  await env.HUB_KV.delete(`cfg:${secret}`);
  await env.HUB_KV.delete(`snap:${secret}`);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (["GET", "HEAD"].includes(request.method)) {
        if (url.pathname === "/health") return json(workerInfo(env));
        // 旧页面 fetch 根路由仍得到 JSON，浏览器导航得到网页。
        if (url.pathname === "/" && !/text\/html/i.test(request.headers.get("Accept") || ""))
          return json(workerInfo(env));
        const aliases = { "/index.html": "/", "/web/": "/", "/web/index.html": "/",
          "/overview.html": "/overview", "/web/overview.html": "/overview" };
        const page = HUB_PAGES[aliases[url.pathname] || url.pathname];
        if (page) return await servePage(page, request.method === "HEAD");
      }
      if (request.method === "GET" && url.pathname.startsWith("/proxy/")) return await handleProxy(request, env);
      if (request.method === "POST" && url.pathname === "/unsubscribe") return await handleUnsubscribe(request, env);
      if (url.pathname === "/setup" || url.pathname === "/ics")
        return json({ error: "v2.2 暂停云端订阅；请在看板下载日历文件" }, 410);
      return json({ error: "未知路径" }, 404);
    } catch (e) {
      // 不将上游响应、凭证、请求地址或内部错误写入日志。
      return json({ error: "请求未完成，请检查学校地址、网络与部署配置" }, 502);
    }
  },
  // 防止旧实例遗留的 Cron 在升级后继续抓取或推送。
  async scheduled() {},
};
