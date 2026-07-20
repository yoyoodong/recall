import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
const DEFAULT_AUTH_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const DEFAULT_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const DEFAULT_SCOPES = [
  "contact:user.id:readonly",
  "offline_access",
  "bitable:app",
  "bitable:app:readonly",
  "calendar:calendar",
  "calendar:calendar:readonly"
].join(" ");

const FIELD_SCHEMA = [
  { key: "title", name: "标题", type: 1 },
  { key: "screenshot", name: "网页截图", type: 17 },
  { key: "coreContent", name: "核心内容", type: 1 },
  { key: "url", name: "链接", type: 15 },
  { key: "source", name: "来源", type: 1 },
  { key: "tags", name: "标签", type: 4, property: { options: [] } },
  { key: "priority", name: "重要度", type: 3, property: { options: [{ name: "普通" }, { name: "重要" }] } },
  { key: "status", name: "状态", type: 3, property: { options: [{ name: "未读" }, { name: "已读" }] } },
  { key: "remindAt", name: "提醒时间", type: 5 },
  { key: "capturedAt", name: "保存时间", type: 5 },
  { key: "calendarEventId", name: "日历事件ID", type: 1 }
];

export default async function handler(req, context) {
  const origin = req.headers.get("origin") || "";

  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), origin);
  }

  try {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      return json({ ok: true, service: "recall-public", time: new Date().toISOString() }, 200, origin);
    }

    if (req.method === "GET" && pathname === "/api/auth/start") {
      return await startAuth(url, origin);
    }

    if (req.method === "GET" && pathname === "/api/auth/callback") {
      return await finishAuth(url, origin);
    }

    if (req.method === "GET" && pathname === "/api/me") {
      const session = await requireSession(req);
      return json({
        ok: true,
        connectedAt: session.connectedAt,
        baseUrl: session.workspace?.baseUrl || "",
        user: session.user || null
      }, 200, origin);
    }

    if (req.method === "POST" && pathname === "/api/captures") {
      const session = await requireSession(req);
      const capture = normalizeCapture(await req.json().catch(() => ({})));
      const result = await saveCapture(session, capture, url);
      return json({ ok: true, ...result }, 201, origin);
    }

    if (req.method === "GET" && pathname === "/read") {
      return await markReadAndRedirect(url, origin);
    }

    return json({ ok: false, error: "Not found" }, 404, origin);
  } catch (error) {
    console.error("Recall function error", {
      message: error.message,
      status: error.status,
      code: error.code,
      details: error.details
    });
    try {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/callback") {
        return htmlError(error);
      }
    } catch {
      // Fall through to JSON error response.
    }
    return json({
      ok: false,
      error: error.message || "Server error",
      code: error.code || undefined
    }, error.status || 500, origin);
  }
}

export const config = {
  path: ["/health", "/api/auth/start", "/api/auth/callback", "/api/me", "/api/captures", "/read"],
  method: ["GET", "POST", "OPTIONS"]
};

async function startAuth(url, origin) {
  assertRequiredEnv(["PUBLIC_BASE_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "SESSION_SECRET"]);

  const extensionRedirectUri = url.searchParams.get("redirect_uri") || "";
  if (!extensionRedirectUri.startsWith("chrome-extension://")) {
    throw httpError(400, "Invalid extension redirect URI.");
  }

  if (env("PUBLIC_AUTH_MODE") === "dev") {
    const sessionToken = await createSession({
      user: { id: `dev-${Date.now()}`, name: "Dev User" },
      token: { dev: true },
      workspace: devWorkspace(),
      connectedAt: new Date().toISOString()
    });
    return redirectToExtension(extensionRedirectUri, sessionToken, devWorkspace().baseUrl);
  }

  const state = createOAuthState({
    extensionRedirectUri,
    extensionId: url.searchParams.get("extension_id") || "",
    createdAt: Date.now()
  });

  const authUrl = new URL(env("FEISHU_OAUTH_AUTHORIZE_URL") || DEFAULT_AUTH_URL);
  authUrl.searchParams.set("client_id", env("FEISHU_APP_ID"));
  authUrl.searchParams.set("redirect_uri", redirectUri());
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", env("FEISHU_OAUTH_SCOPE") || DEFAULT_SCOPES);

  return withCors(Response.redirect(authUrl.toString(), 302), origin);
}

async function finishAuth(url, origin) {
  assertRequiredEnv(["PUBLIC_BASE_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "SESSION_SECRET"]);

  const oauthError = url.searchParams.get("error") || "";
  if (oauthError) {
    const description = url.searchParams.get("error_description") || url.searchParams.get("error_msg") || oauthError;
    throw httpError(400, `Feishu OAuth rejected the request: ${description}`);
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const stateRecord = verifyOAuthState(state);

  if (!code || !stateRecord?.extensionRedirectUri) {
    throw httpError(400, "Invalid OAuth callback.");
  }

  const token = await exchangeFeishuCode(code);
  const user = await getFeishuUser(token);
  const workspace = await ensureUserWorkspace(token, user);
  const sessionToken = await createSession({
    user,
    token: encryptTokenPayload(token),
    workspace,
    connectedAt: new Date().toISOString()
  });

  return redirectToExtension(stateRecord.extensionRedirectUri, sessionToken, workspace.baseUrl || "");
}

async function exchangeFeishuCode(code) {
  const data = await feishuFetch(env("FEISHU_OAUTH_TOKEN_URL") || DEFAULT_TOKEN_URL, {
    method: "POST",
    body: {
      grant_type: "authorization_code",
      client_id: env("FEISHU_APP_ID"),
      client_secret: env("FEISHU_APP_SECRET"),
      code,
      redirect_uri: redirectUri()
    }
  });
  return data.data || data;
}

async function getFeishuUser(token) {
  const accessToken = token.access_token || token.user_access_token;
  if (!accessToken) throw httpError(502, "Feishu OAuth response did not include user access token.");
  const data = await feishuFetch(`${FEISHU_API_BASE}/authen/v1/user_info`, {
    accessToken
  });
  const user = data.data || data;
  return {
    id: user.open_id || user.union_id || user.user_id || crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 20),
    name: user.name || user.en_name || ""
  };
}

async function ensureUserWorkspace(token, user) {
  const existing = await workspacesStore().get(user.id, { type: "json" });
  if (existing?.appToken && existing?.tableId) return existing;

  if (env("PUBLIC_WORKSPACE_MODE") === "manual") {
    const workspace = manualWorkspace();
    await workspacesStore().setJSON(user.id, workspace);
    return workspace;
  }

  const accessToken = token.access_token || token.user_access_token;
  if (!accessToken) throw httpError(502, "Missing user access token.");

  const workspace = await provisionFeishuWorkspace(accessToken);
  await workspacesStore().setJSON(user.id, workspace);
  return workspace;
}

async function provisionFeishuWorkspace(accessToken) {
  if (env("FEISHU_AUTO_PROVISION") !== "true") {
    throw httpError(501, "Auto Base provisioning is disabled. Set FEISHU_AUTO_PROVISION=true after Feishu scopes are approved.");
  }

  const appPayload = await feishuFetch(`${FEISHU_API_BASE}/bitable/v1/apps`, {
    method: "POST",
    accessToken,
    body: { name: env("RECALL_BASE_NAME") || "看了会发财" }
  });
  const appToken = appPayload.data?.app?.app_token || appPayload.data?.app_token || appPayload.app_token;
  if (!appToken) {
    throw httpError(502, "Feishu did not return a bitable app_token.");
  }

  const tablePayload = await feishuFetch(`${FEISHU_API_BASE}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
    method: "POST",
    accessToken,
    body: { table: { name: env("RECALL_TABLE_NAME") || "资料箱" } }
  });
  const tableId = tablePayload.data?.table_id || tablePayload.data?.table?.table_id || tablePayload.table_id;
  if (!tableId) {
    throw httpError(502, "Feishu did not return a table_id.");
  }

  const fields = {};
  for (const field of FIELD_SCHEMA.slice(1)) {
    try {
      const created = await feishuFetch(`${FEISHU_API_BASE}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`, {
        method: "POST",
        accessToken,
        body: {
          field_name: field.name,
          type: field.type,
          ...(field.property ? { property: field.property } : {})
        }
      });
      fields[field.key] = created.data?.field?.field_id || field.name;
    } catch (error) {
      if (!String(error.message || "").includes("duplicated")) throw error;
      fields[field.key] = field.name;
    }
  }

  return {
    appToken,
    tableId,
    baseUrl: `${feishuBaseUrl()}/base/${appToken}?table=${tableId}`,
    fields
  };
}

async function saveCapture(session, capture, requestUrl) {
  if (session.token?.dev) {
    const recordId = randomToken(12);
    await capturesStore().setJSON(recordId, {
      sessionToken: "",
      userId: session.user?.id || "",
      capture,
      savedAt: new Date().toISOString()
    });
    return { recordId, baseUrl: session.workspace?.baseUrl || "", devStored: true };
  }

  const token = decryptTokenPayload(session.token);
  const accessToken = token.access_token || token.user_access_token;
  if (!accessToken) throw httpError(401, "Feishu session expired. Please reconnect.");

  const workspace = session.workspace;
  if (!workspace?.appToken || !workspace?.tableId) {
    throw httpError(409, "Feishu workspace is not ready.");
  }

  const record = await createBitableRecord(accessToken, workspace, capture);
  const recordId = getRecordId(record);
  let calendarEventId = "";
  if (capture.remindAt && recordId) {
    calendarEventId = await createCalendarReminder(accessToken, capture, recordId, requestUrl).catch((error) => {
      console.error(`Calendar reminder failed: ${error.message}`);
      return "";
    });
    if (calendarEventId) {
      await updateBitableRecord(accessToken, workspace, recordId, { [fieldName("calendarEventId", workspace)]: calendarEventId }).catch(() => {});
    }
  }

  return { recordId, calendarEventId, baseUrl: workspace.baseUrl || "" };
}

async function createBitableRecord(accessToken, workspace, capture) {
  const fields = {
    [fieldName("title", workspace)]: capture.title,
    [fieldName("coreContent", workspace)]: buildCoreContent(capture),
    [fieldName("url", workspace)]: capture.url,
    [fieldName("source", workspace)]: capture.source,
    [fieldName("tags", workspace)]: capture.tags,
    [fieldName("priority", workspace)]: capture.priority || "普通",
    [fieldName("status", workspace)]: capture.status || "未读",
    [fieldName("remindAt", workspace)]: toFeishuDate(capture.remindAt),
    [fieldName("capturedAt", workspace)]: Date.now()
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) delete fields[key];
  }

  const data = await feishuFetch(`${FEISHU_API_BASE}/bitable/v1/apps/${encodeURIComponent(workspace.appToken)}/tables/${encodeURIComponent(workspace.tableId)}/records`, {
    method: "POST",
    accessToken,
    body: { fields }
  });
  return data.data?.record || data.data || data;
}

async function updateBitableRecord(accessToken, workspace, recordId, fields) {
  return feishuFetch(`${FEISHU_API_BASE}/bitable/v1/apps/${encodeURIComponent(workspace.appToken)}/tables/${encodeURIComponent(workspace.tableId)}/records/${encodeURIComponent(recordId)}`, {
    method: "PUT",
    accessToken,
    body: { fields }
  });
}

async function createCalendarReminder(accessToken, capture, recordId, requestUrl) {
  const calendarId = await getPrimaryCalendarId(accessToken);
  const startMs = toFeishuDate(capture.remindAt) || tomorrowMorningMs();
  const readUrl = new URL("/read", requestUrl.origin);
  readUrl.searchParams.set("record_id", recordId);
  readUrl.searchParams.set("s", signReadToken(recordId));

  const event = await feishuFetch(`${FEISHU_API_BASE}/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    accessToken,
    body: {
      summary: `回看：${trimText(capture.title || "发财资料", 60)}`,
      description: [`阅读入口：${readUrl.toString()}`, capture.url ? `原始链接：${capture.url}` : ""].filter(Boolean).join("\n\n"),
      start_time: { timestamp: String(Math.floor(startMs / 1000)), timezone: "Asia/Shanghai" },
      end_time: { timestamp: String(Math.floor((startMs + 30 * 60 * 1000) / 1000)), timezone: "Asia/Shanghai" },
      free_busy_status: "free",
      visibility: "private",
      reminders: [{ minutes: 0 }]
    }
  });
  return event.data?.event?.event_id || event.data?.event_id || event.event_id || "";
}

async function getPrimaryCalendarId(accessToken) {
  const data = await feishuFetch(`${FEISHU_API_BASE}/calendar/v4/calendars/primary`, {
    method: "POST",
    accessToken
  });
  const entry = data.data?.calendars?.[0];
  const calendarId = entry?.calendar?.calendar_id || entry?.calendar_id;
  if (!calendarId) throw httpError(502, "Cannot resolve primary Feishu calendar.");
  return calendarId;
}

async function markReadAndRedirect(url, origin) {
  const recordId = url.searchParams.get("record_id") || "";
  const signature = url.searchParams.get("s") || "";
  if (!recordId || signature !== signReadToken(recordId)) {
    return withCors(new Response("阅读链接无效。", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }), origin);
  }
  return withCors(new Response("已收到阅读请求。公开版状态同步会在飞书写入闭环完成后启用。", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  }), origin);
}

async function createSession(payload) {
  const token = randomToken(32);
  await sessionsStore().setJSON(token, payload);
  return token;
}

async function requireSession(req) {
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, "Missing Recall session.");
  const session = await sessionsStore().get(match[1], { type: "json" });
  if (!session) throw httpError(401, "Invalid or expired Recall session.");
  return session;
}

function redirectToExtension(extensionRedirectUri, sessionToken, baseUrl) {
  const redirect = new URL(extensionRedirectUri);
  redirect.hash = new URLSearchParams({
    recall_token: sessionToken,
    base_url: baseUrl || ""
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      "Cache-Control": "no-store"
    }
  });
}

async function feishuFetch(url, options = {}) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code) {
    const error = httpError(502, data.msg || data.error_description || `Feishu API failed with HTTP ${response.status}`);
    error.code = data.code || response.status;
    error.details = {
      feishuCode: data.code,
      feishuMsg: data.msg,
      requestId: data.request_id,
      url: String(url)
    };
    throw error;
  }
  return data;
}

function normalizeCapture(capture) {
  const input = capture && typeof capture === "object" ? capture : {};
  return {
    title: stringValue(input.title).slice(0, 500) || "未命名资料",
    url: stringValue(input.url),
    source: stringValue(input.source),
    selectedText: stringValue(input.selectedText).slice(0, 10000),
    pageText: stringValue(input.pageText).slice(0, 12000),
    description: stringValue(input.description).slice(0, 2000),
    headings: Array.isArray(input.headings) ? input.headings.map(stringValue).filter(Boolean).slice(0, 8) : [],
    tags: Array.isArray(input.tags) ? input.tags.map(stringValue).filter(Boolean).slice(0, 5) : [],
    priority: stringValue(input.priority || "普通"),
    status: stringValue(input.status || "未读"),
    remindAt: stringValue(input.remindAt),
    screenshot: normalizeScreenshot(input.screenshot)
  };
}

function normalizeScreenshot(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.dataUrl !== "string" || !/^data:image\/(?:png|jpe?g);base64,/.test(value.dataUrl)) return null;
  return {
    dataUrl: value.dataUrl,
    name: stringValue(value.name || "screenshot.jpg").slice(0, 180)
  };
}

function buildCoreContent(capture) {
  const lines = [];
  lines.push(`精炼摘要：${trimText(capture.description || capture.selectedText || capture.title, 260)}`);
  if (capture.headings.length) lines.push(`阅读路径：${capture.headings.map((item) => trimText(item, 80)).join(" / ")}`);
  if (capture.selectedText) lines.push(`关键摘录：${trimText(capture.selectedText, 360)}`);
  lines.push("值得看的点：先扫标题和小节，再判断是否值得深读。");
  return lines.join("\n");
}

function fieldName(key, workspace) {
  return workspace.fields?.[key] || FIELD_SCHEMA.find((field) => field.key === key)?.name || key;
}

function manualWorkspace() {
  assertRequiredEnv(["PUBLIC_MANUAL_BASE_TOKEN", "PUBLIC_MANUAL_TABLE_ID", "PUBLIC_MANUAL_BASE_URL"]);
  return {
    appToken: env("PUBLIC_MANUAL_BASE_TOKEN"),
    tableId: env("PUBLIC_MANUAL_TABLE_ID"),
    baseUrl: env("PUBLIC_MANUAL_BASE_URL"),
    fields: {}
  };
}

function devWorkspace() {
  return {
    appToken: "dev_base_token",
    tableId: "dev_table_id",
    baseUrl: env("DEV_BASE_URL") || "https://example.com/recall-dev-base",
    fields: {}
  };
}

function sessionsStore() {
  return getStore({ name: "recall-sessions", consistency: "strong" });
}

function workspacesStore() {
  return getStore({ name: "recall-workspaces", consistency: "strong" });
}

function capturesStore() {
  return getStore({ name: "recall-captures", consistency: "strong" });
}

function encryptTokenPayload(token) {
  const secret = env("SESSION_SECRET");
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: true,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    value: encrypted.toString("base64url")
  };
}

function decryptTokenPayload(payload) {
  if (!payload?.encrypted) return payload || {};
  const key = crypto.createHash("sha256").update(env("SESSION_SECRET")).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.value, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function signReadToken(recordId) {
  return crypto.createHmac("sha256", env("SESSION_SECRET") || "dev").update(recordId).digest("base64url").slice(0, 32);
}

function createOAuthState(payload) {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    nonce: randomToken(12)
  }), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

function verifyOAuthState(state) {
  const [body, signature] = String(state || "").split(".");
  if (!body || !signature || signature !== signStateBody(body)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (Date.now() - Number(payload.createdAt || 0) > 10 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function signStateBody(body) {
  return crypto.createHmac("sha256", env("SESSION_SECRET") || "dev").update(body).digest("base64url").slice(0, 32);
}

function assertRequiredEnv(keys) {
  const missing = keys.filter((key) => !env(key));
  if (missing.length) throw httpError(500, `Missing backend env: ${missing.join(", ")}`);
}

function env(key) {
  return globalThis.Netlify?.env?.get(key) || process.env[key] || "";
}

function redirectUri() {
  return env("FEISHU_REDIRECT_URI") || `${env("PUBLIC_BASE_URL").replace(/\/$/, "")}/api/auth/callback`;
}

function feishuBaseUrl() {
  return env("FEISHU_BASE_WEB_URL") || "https://www.feishu.cn";
}

function toFeishuDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(/-/g, "/"));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function tomorrowMorningMs() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date.getTime();
}

function getRecordId(record) {
  return record?.record_id || record?.id || record?.record?.record_id || "";
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function trimText(text, maxLength) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(payload, status, origin) {
  return withCors(new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  }), origin);
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function htmlError(error) {
  const status = error.status || 500;
  const title = status >= 500 ? "连接飞书时后端出错" : "连接飞书失败";
  const details = [
    error.message || "Server error",
    error.code ? `错误码：${error.code}` : "",
    error.details?.feishuCode ? `飞书错误码：${error.details.feishuCode}` : "",
    error.details?.feishuMsg ? `飞书信息：${error.details.feishuMsg}` : "",
    error.details?.requestId ? `飞书 request_id：${error.details.requestId}` : ""
  ].filter(Boolean);
  const escapedDetails = details.map(escapeHtml);
  return new Response(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f8fb;color:#172033}
      main{width:min(760px,calc(100vw - 40px));background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;box-shadow:0 18px 48px rgba(18,28,45,.08)}
      h1{margin:0 0 12px;font-size:28px;letter-spacing:0}
      p{margin:8px 0;color:#4b5565;line-height:1.7}
      pre{white-space:pre-wrap;word-break:break-word;background:#f3f4f6;border-radius:8px;padding:16px;color:#111827}
      .hint{margin-top:20px;padding-top:18px;border-top:1px solid #e5e7eb}
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>这说明飞书已经回调到 Recall 后端，但后端在换取 token、创建资料表或跳回插件时遇到了问题。</p>
      <pre>${escapedDetails.join("\n") || "未知错误"}</pre>
      <div class="hint">
        <p>请回到 Recall 插件设置页，重新点击“连接飞书”。如果仍失败，把这一页的错误信息发给开发者。</p>
      </div>
    </main>
  </body>
</html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
