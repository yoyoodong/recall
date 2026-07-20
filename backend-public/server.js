import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";

loadLocalEnv();

const env = process.env;
const port = Number(env.PORT || 8788);
const dbPath = env.RECALL_DB_PATH || new URL("./recall-public-db.json", import.meta.url).pathname;
const db = loadDb();

const oauthStates = new Map();

const REQUIRED_ENV = [
  "PUBLIC_BASE_URL",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_OAUTH_AUTHORIZE_URL",
  "FEISHU_OAUTH_TOKEN_URL",
  "FEISHU_REDIRECT_URI",
  "SESSION_SECRET"
];

const server = http.createServer(async (req, res) => {
  setCors(res, req.headers.origin || "");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "recall-public-backend" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/start") {
      if (isDevAuthMode()) {
        handleDevAuthStart(url, res);
        return;
      }
      requireOAuthEnv();
      handleAuthStart(url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/callback") {
      requireOAuthEnv();
      await handleAuthCallback(url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const session = requireSession(req);
      sendJson(res, 200, {
        ok: true,
        baseUrl: session.baseUrl || "",
        connectedAt: session.connectedAt
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/captures") {
      const session = requireSession(req);
      const capture = await readJson(req);
      const result = await saveCaptureForUser(session, capture);
      sendJson(res, 201, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      error: error.message || "Server error"
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Recall public backend listening on http://127.0.0.1:${port}`);
});

function handleDevAuthStart(url, res) {
  const extensionRedirectUri = url.searchParams.get("redirect_uri") || "";
  if (!extensionRedirectUri.startsWith("chrome-extension://")) {
    throw httpError(400, "Invalid extension redirect URI.");
  }

  const workspace = {
    baseUrl: env.DEV_BASE_URL || "https://example.com/recall-dev-base",
    appToken: env.DEV_BASE_TOKEN || "dev_base_token",
    tableId: env.DEV_TABLE_ID || "dev_table_id"
  };
  const sessionToken = createSession({
    user: { id: "dev-user", name: "Dev User" },
    token: { dev: true },
    base: workspace
  });

  const redirect = new URL(extensionRedirectUri);
  redirect.hash = new URLSearchParams({
    recall_token: sessionToken,
    base_url: workspace.baseUrl
  }).toString();

  res.writeHead(302, { Location: redirect.toString() });
  res.end();
}

function handleAuthStart(url, res) {
  const extensionRedirectUri = url.searchParams.get("redirect_uri") || "";
  if (!extensionRedirectUri.startsWith("chrome-extension://")) {
    throw httpError(400, "Invalid extension redirect URI.");
  }

  const state = randomToken(24);
  oauthStates.set(state, {
    extensionRedirectUri,
    createdAt: Date.now()
  });

  const authUrl = new URL(env.FEISHU_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", env.FEISHU_APP_ID);
  authUrl.searchParams.set("redirect_uri", env.FEISHU_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", state);
  if (env.FEISHU_OAUTH_SCOPE) {
    authUrl.searchParams.set("scope", env.FEISHU_OAUTH_SCOPE);
  }

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function handleAuthCallback(url, res) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const stateRecord = oauthStates.get(state);
  oauthStates.delete(state);

  if (!code || !stateRecord) {
    throw httpError(400, "Invalid OAuth callback.");
  }

  const token = await exchangeFeishuCode(code);
  const user = await getFeishuUser(token);
  const workspace = await ensureUserBase(token, user);
  const sessionToken = createSession({
    user,
    token,
    base: workspace
  });

  const redirect = new URL(stateRecord.extensionRedirectUri);
  redirect.hash = new URLSearchParams({
    recall_token: sessionToken,
    base_url: workspace.baseUrl || ""
  }).toString();

  res.writeHead(302, { Location: redirect.toString() });
  res.end();
}

async function exchangeFeishuCode(code) {
  const response = await fetch(env.FEISHU_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.FEISHU_APP_ID,
      client_secret: env.FEISHU_APP_SECRET,
      code,
      redirect_uri: env.FEISHU_REDIRECT_URI
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code) {
    throw httpError(502, data.msg || "Feishu OAuth token exchange failed.");
  }
  return data.data || data;
}

async function getFeishuUser(token) {
  if (env.SKIP_FEISHU_USER_LOOKUP === "true") {
    return { id: `dev-${Date.now()}` };
  }

  const accessToken = token.access_token || token.user_access_token;
  if (!accessToken) throw httpError(502, "Feishu OAuth response did not include user access token.");

  const response = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code) {
    throw httpError(502, data.msg || "Feishu user lookup failed.");
  }
  const user = data.data || data;
  return {
    id: user.open_id || user.union_id || user.user_id,
    name: user.name || user.en_name || ""
  };
}

async function ensureUserBase(token, user) {
  if (env.DEV_BASE_URL && env.DEV_BASE_TOKEN && env.DEV_TABLE_ID) {
    return {
      baseUrl: env.DEV_BASE_URL,
      appToken: env.DEV_BASE_TOKEN,
      tableId: env.DEV_TABLE_ID
    };
  }

  // Production implementation:
  // 1. Look up the user's existing Recall workspace in the database.
  // 2. If absent, create a Feishu Base and table with the Recall schema.
  // 3. Store base app_token, table_id, field IDs, and base URL per user.
  throw httpError(501, "User Base provisioning is not configured yet.");
}

async function saveCaptureForUser(session, capture) {
  if (!session.base?.appToken || !session.base?.tableId) {
    throw httpError(409, "Feishu Base is not ready for this user.");
  }

  if (isDevAuthMode() || session.token?.dev) {
    const record = {
      id: randomToken(12),
      userId: session.user?.id || "unknown",
      baseUrl: session.base.baseUrl,
      capture: normalizeCapture(capture),
      savedAt: new Date().toISOString()
    };
    db.captures.push(record);
    saveDb();
    return {
      recordId: record.id,
      baseUrl: session.base.baseUrl,
      devStored: true
    };
  }

  // Production implementation remains in the Feishu adapter:
  // create a Base record using the user's token, then upload screenshot.
  return {
    queued: true,
    baseUrl: session.base.baseUrl,
    message: "Capture accepted by backend skeleton. Feishu write adapter is pending."
  };
}

function createSession(payload) {
  const token = randomToken(32);
  db.sessions[token] = {
    ...payload,
    connectedAt: new Date().toISOString()
  };
  saveDb();
  return token;
}

function requireSession(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, "Missing Recall session.");
  const session = db.sessions[match[1]];
  if (!session) throw httpError(401, "Invalid or expired Recall session.");
  return session;
}

function requireOAuthEnv() {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length) {
    throw httpError(500, `Missing backend env: ${missing.join(", ")}`);
  }
}

function isDevAuthMode() {
  return env.PUBLIC_AUTH_MODE === "dev";
}

function normalizeCapture(capture) {
  const input = capture && typeof capture === "object" ? capture : {};
  return {
    title: stringValue(input.title).slice(0, 500),
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

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    return {
      sessions: parsed.sessions || {},
      users: parsed.users || {},
      captures: Array.isArray(parsed.captures) ? parsed.captures : []
    };
  } catch {
    return { sessions: {}, users: {}, captures: [] };
  }
}

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function loadLocalEnv() {
  const envPath = new URL("./.env", import.meta.url).pathname;
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (process.env[match[1]] == null) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        reject(httpError(413, "Payload too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(httpError(400, "Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
