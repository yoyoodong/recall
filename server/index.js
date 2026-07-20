import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";

const env = loadEnv();
const port = Number(env.CAPTURE_PORT || 8787);
const writeMode = env.LARK_WRITE_MODE || "lark-cli";
const larkCliCommand = env.LARK_CLI_PATH || firstExistingPath([
  "/Users/dongdong/.npm-global/bin/lark-cli",
  "/usr/local/bin/lark-cli",
  "/opt/homebrew/bin/lark-cli",
  "lark-cli"
]);

const required = writeMode === "api"
  ? ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_APP_TOKEN", "LARK_TABLE_ID"]
  : ["LARK_APP_TOKEN", "LARK_TABLE_ID"];
const missing = required.filter((key) => !env[key]);
if (missing.length > 0) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  console.error("Create .env from .env.example and fill your Feishu app/base settings.");
  process.exit(1);
}

let tokenCache = {
  token: "",
  expiresAt: 0
};

let reminderSyncRunning = false;
const calendarEventsEnabled = env.CALENDAR_EVENTS_ENABLED === "true" && Boolean(env.FIELD_CALENDAR_EVENT_ID);

const fieldMap = {
  title: env.FIELD_TITLE || "标题",
  url: env.FIELD_URL || "链接",
  source: env.FIELD_SOURCE || "来源",
  coreContent: env.FIELD_CORE_CONTENT || "核心内容",
  tags: env.FIELD_TAGS || "标签",
  priority: env.FIELD_PRIORITY || "重要度",
  status: env.FIELD_STATUS || "状态",
  remindAt: env.FIELD_REMIND_AT || "提醒时间",
  capturedAt: env.FIELD_CAPTURED_AT || "保存时间",
  calendarEventId: env.FIELD_CALENDAR_EVENT_ID || "",
  screenshot: env.FIELD_SCREENSHOT || "网页截图"
};

let cachedPrimaryCalendarId = null;
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "feishu-capture", time: new Date().toISOString() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/read") {
      await handleReadLink(url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reminders/rebuild") {
      if (!isAllowedOrigin(origin)) {
        sendJson(res, 403, { ok: false, error: "Only the Chrome extension may use this helper." });
        return;
      }
      assertApiKey(req);
      if (!calendarEventsEnabled) {
        sendJson(res, 200, { ok: true, result: { disabled: true } });
        return;
      }
      const result = await rebuildAggregateReadingCalendars();
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/captures") {
      if (!isAllowedOrigin(origin)) {
        sendJson(res, 403, { ok: false, error: "Only the Chrome extension may use this helper." });
        return;
      }
      assertApiKey(req);
      const body = await readJson(req);
      const capture = normalizeCapture(body);
      const record = await createFeishuRecord(capture);
      sendJson(res, 201, { ok: true, record, capture });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, {
      ok: false,
      error: error.message || "Server error",
      details: error.details
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Feishu capture server listening on http://127.0.0.1:${port}`);
  startReminderSyncLoop();
});

function loadEnv() {
  const values = { ...process.env };
  if (!fs.existsSync(".env")) return values;
  const content = fs.readFileSync(".env", "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    values[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
  }
  return paths[paths.length - 1];
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return origin.startsWith("chrome-extension://");
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin && origin.startsWith("chrome-extension://") ? origin : "null");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Capture-Key");
}

function assertApiKey(req) {
  if (!env.CAPTURE_API_KEY) return;
  if (req.headers["x-capture-key"] !== env.CAPTURE_API_KEY) {
    const error = new Error("Invalid API key");
    error.status = 401;
    throw error;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    const maxPayloadBytes = Number(env.MAX_CAPTURE_PAYLOAD_MB || 25) * 1024 * 1024;
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxPayloadBytes) {
        const error = new Error("Payload too large");
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error("Invalid JSON");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeCapture(body) {
  const now = new Date();
  const remindDate = normalizeDate(body.remindAt);
  const capture = {
    title: stringOrEmpty(body.title).slice(0, 500),
    url: stringOrEmpty(body.url),
    source: stringOrEmpty(body.source),
    selectedText: stringOrEmpty(body.selectedText).slice(0, 10000),
    pageText: stringOrEmpty(body.pageText).slice(0, 12000),
    description: stringOrEmpty(body.description).slice(0, 2000),
    headings: normalizeHeadings(body.headings),
    tags: normalizeTags(body.tags),
    priority: stringOrEmpty(body.priority || "普通"),
    status: stringOrEmpty(body.status || "未读"),
    remindAt: remindDate ? formatFeishuDateTime(remindDate) : "",
    remindAtMs: remindDate ? remindDate.getTime() : null,
    capturedAt: formatFeishuDateTime(now),
    capturedAtMs: now.getTime(),
    screenshot: normalizeScreenshot(body.screenshot)
  };

  if (!capture.title && !capture.url) {
    const error = new Error("Title or URL is required");
    error.status = 400;
    throw error;
  }
  if (capture.tags.length === 0) {
    capture.tags = inferTags(capture);
  }
  capture.coreContent = buildCoreContent(capture);

  return capture;
}

function inferTags(capture) {
  const text = [
    capture.title,
    capture.url,
    capture.source,
    capture.selectedText
    ,capture.pageText
  ].filter(Boolean).join(" ").toLowerCase();
  const tags = [];

  addTag(tags, "视频", /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|video|视频|影片|播客|podcast/.test(text));
  addTag(tags, "AI", /\bai\b|artificial intelligence|machine learning|llm|大模型|人工智能|生成式|智能体|agent/.test(text));
  addTag(tags, "AI视频生成", /runway|sora|pika|kling|可灵|hailuo|海螺|veo|video generation|text to video|image to video|视频生成/.test(text));
  addTag(tags, "AI图像生成", /midjourney|stable diffusion|flux|image generation|text to image|图像生成|图片生成/.test(text));
  addTag(tags, "代码", /github\.com|gitlab\.com|source code|open source|开源|代码|repository|repo/.test(text));
  addTag(tags, "论文", /arxiv\.org|doi\.org|paper|research|论文|研究|preprint|abstract/.test(text));
  addTag(tags, "产品工具", /product|tool|app|platform|software|generator|工具|产品|平台|应用|助手/.test(text));
  addTag(tags, "商业分析", /business|capital|market|startup|funding|invest|revenue|strategy|商业|资本|市场|创业|融资|投资|战略/.test(text));
  addTag(tags, "教程方法", /guide|tutorial|how to|course|learn|workflow|playbook|教程|指南|方法|学习|工作流/.test(text));
  addTag(tags, "新闻资讯", /news|announced|launch|release|breaking|update|新闻|发布|宣布|更新|快讯/.test(text));
  addTag(tags, "设计创意", /design|creative|fashion|style|image|视觉|设计|创意|时尚|审美/.test(text));

  if (tags.length === 0) tags.push("网页资料");
  return tags.slice(0, 5);
}

function addTag(tags, tag, condition) {
  if (condition && !tags.includes(tag)) tags.push(tag);
}

function normalizeScreenshot(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.dataUrl !== "string" || !/^data:image\/(?:png|jpe?g);base64,/.test(value.dataUrl)) return null;
  return {
    dataUrl: value.dataUrl,
    name: stringOrEmpty(value.name || "网页截图.jpg").slice(0, 180) || "网页截图.jpg"
  };
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(stringOrEmpty).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean);
}

function normalizeHeadings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(stringOrEmpty).filter(Boolean).slice(0, 8);
}

function buildCoreContent(capture) {
  const sentences = splitSentences([capture.description, capture.selectedText, capture.pageText].filter(Boolean).join(" "));
  const summary = trimText(capture.description || sentences.slice(0, 3).join(" ") || capture.title, 700);
  const viewpoints = uniqueStrings(capture.headings.concat(sentences.slice(0, 5))).slice(0, 5);
  const worthwhile = uniqueStrings([
    capture.selectedText ? `已选重点：${trimText(capture.selectedText, 280)}` : "",
    ...capture.headings.slice(0, 3).map((heading) => `可重点看：${trimText(heading, 120)}`)
  ]).slice(0, 3);
  const prompt = buildReadingPrompt(capture);
  const lines = [`精炼摘要：${summary}`];
  if (viewpoints.length) lines.push(`核心观点：\n${viewpoints.map((item, index) => `${index + 1}. ${trimText(item, 260)}`).join("\n")}`);
  if (worthwhile.length) lines.push(`值得看的点：\n${worthwhile.map((item) => `- ${item}`).join("\n")}`);
  lines.push(`启发思考：${prompt}`);
  return lines.join("\n\n").slice(0, 8000);
}

function splitSentences(text) {
  return String(text || "").replace(/\s+/g, " ").split(/(?<=[。！？.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 18)
    .slice(0, 12);
}

function buildReadingPrompt(capture) {
  const tags = capture.tags.join(" ");
  if (/论文|研究/.test(tags)) return "重点判断研究问题、方法、证据与结论之间是否匹配，以及它能否迁移到你的实际场景。";
  if (/教程方法|代码/.test(tags)) return "重点找第一个可复现的步骤，再判断投入时间与可获得的结果是否成比例。";
  if (/商业分析/.test(tags)) return "重点看它说清了什么机会、约束或验证信号，哪些判断可以迁移到你的项目。";
  if (/AI|产品工具/.test(tags)) return "重点判断它改变了哪一个工作环节，是否能在你当前流程中用一个小实验验证。";
  return "带着“它解决了什么问题、最值得保留的一点是什么、能否转成一个行动”这三个问题快速判断。";
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date;
}

function formatFeishuDateTime(date) {
  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds())
  ].join("");
}

async function createFeishuRecord(capture) {
  if (writeMode === "lark-cli") {
    return createFeishuRecordWithCli(capture);
  }

  const token = await getTenantAccessToken();
  const fields = buildFields(capture);
  const endpoint = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.LARK_APP_TOKEN}/tables/${env.LARK_TABLE_ID}/records`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ fields })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    const error = new Error(data.msg || `Feishu record create failed with HTTP ${response.status}`);
    error.status = 502;
    error.details = { code: data.code, msg: data.msg, requestId: data.request_id };
    throw error;
  }
  return data.data?.record || data.data;
}

async function createFeishuRecordWithCli(capture) {
  const fields = buildFields(capture);
  const result = await runCommand(larkCliCommand, [
    "base",
    "+record-upsert",
    "--base-token",
    env.LARK_APP_TOKEN,
    "--table-id",
    env.LARK_TABLE_ID,
    "--json",
    JSON.stringify(fields)
  ]);

  const data = parseJson(result.stdout);
  if (!data || data.ok === false) {
    const error = new Error(data?.error?.message || result.stderr || "lark-cli write failed");
    error.status = 502;
    error.details = data || { stderr: result.stderr };
    throw error;
  }

  const record = data.record || data.data?.record || data;
  const recordId = getCreatedRecordId(record);
  if (calendarEventsEnabled && recordId && capture.status !== "已读" && capture.remindAtMs) {
    try {
      const eventId = await refreshAggregateReadingCalendar(capture.remindAtMs);
      if (eventId) {
        record.calendar_event_id = eventId;
      }
    } catch (error) {
      record.calendar_error = error.message;
    }
  }

  if (recordId && capture.screenshot) {
    try {
      await uploadScreenshotAttachment(recordId, capture.screenshot);
      record.screenshot_uploaded = true;
    } catch (error) {
      record.screenshot_error = error.message;
      console.error(`Screenshot upload failed for ${recordId}: ${error.message}`);
    }
  }

  return record;
}

async function uploadScreenshotAttachment(recordId, screenshot) {
  const filePath = await writeScreenshotTempFile(screenshot);
  try {
    await runCommand(larkCliCommand, [
      "base",
      "+record-upload-attachment",
      "--base-token",
      env.LARK_APP_TOKEN,
      "--table-id",
      env.LARK_TABLE_ID,
      "--record-id",
      recordId,
      "--field-id",
      fieldMap.screenshot,
      "--file",
      path.relative(process.cwd(), filePath),
      "--format",
      "json"
    ]);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

async function writeScreenshotTempFile(screenshot) {
  const safeName = screenshot.name.replace(/[^\w.-]+/g, "-") || "screenshot.png";
  const dir = path.join(process.cwd(), ".tmp-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `feishu-capture-${Date.now()}-${safeName}`);
  const base64 = screenshot.dataUrl.replace(/^data:image\/(?:png|jpe?g);base64,/, "");
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

async function updateFeishuRecordWithCli(recordId, fields) {
  const result = await runCommand(larkCliCommand, [
    "base",
    "+record-upsert",
    "--base-token",
    env.LARK_APP_TOKEN,
    "--table-id",
    env.LARK_TABLE_ID,
    "--record-id",
    recordId,
    "--json",
    JSON.stringify(fields)
  ]);
  const data = parseJson(result.stdout);
  if (!data || data.ok === false) {
    const error = new Error(data?.error?.message || result.stderr || "lark-cli record update failed");
    error.status = 502;
    error.details = data || { stderr: result.stderr };
    throw error;
  }
  return data.record || data.data?.record || data;
}

function getCreatedRecordId(record) {
  if (!record) return "";
  if (record.record_id) return record.record_id;
  if (Array.isArray(record.record_id_list) && record.record_id_list[0]) return record.record_id_list[0];
  if (record.data?.record?.record_id) return record.data.record.record_id;
  return "";
}

function startReminderSyncLoop() {
  if (!calendarEventsEnabled) return;
  const intervalMinutes = Number(env.REMINDER_SYNC_INTERVAL_MINUTES || 1);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return;

  const run = () => {
    void syncAggregateReadingCalendars().catch((error) => {
      console.error(`Reminder sync failed: ${error.message}`);
    });
  };

  setTimeout(run, 10_000);
  setInterval(run, intervalMinutes * 60 * 1000);
}

async function syncAggregateReadingCalendars() {
  if (reminderSyncRunning) {
    return { skipped: true, reason: "already_running" };
  }

  reminderSyncRunning = true;
  try {
    return await rebuildAggregateReadingCalendars();
  } finally {
    reminderSyncRunning = false;
  }
}

async function refreshAggregateReadingCalendar(remindAtMs, fallbackEventId = "", options = {}) {
  const entries = await listUnreadRecordsForReminder(remindAtMs, options);
  const oldEventIds = uniqueStrings([
    options.preferredEventId,
    fallbackEventId,
    ...(options.ignoreEntryEventIds ? [] : entries.map((entry) => entry.calendarEventId))
  ]);

  if (entries.length === 0) {
    for (const eventId of oldEventIds) {
      await deleteCalendarEvent(eventId).catch(() => {});
    }
    return "";
  }

  let eventId = Object.hasOwn(options, "preferredEventId")
    ? options.preferredEventId
    : oldEventIds[0] || "";
  const payload = buildAggregateCalendarPayload(remindAtMs, entries);
  if (eventId) {
    try {
      await patchCalendarEvent(eventId, payload);
    } catch {
      eventId = "";
    }
  }

  if (!eventId) {
    const event = await createReadingCalendarEvent(payload);
    eventId = getCalendarEventId(event);
  }

  if (options.deleteStale !== false) {
    for (const staleEventId of oldEventIds.filter((oldEventId) => oldEventId !== eventId)) {
      await deleteCalendarEvent(staleEventId).catch(() => {});
    }
  }

  for (const entry of entries) {
    if (entry.calendarEventId !== eventId) {
      await updateFeishuRecordWithCli(entry.recordId, {
        [fieldMap.calendarEventId]: eventId
      });
    }
  }

  return eventId;
}

async function rebuildAggregateReadingCalendars() {
  const allRecords = await listRecordsForReminder();
  const allEventIds = uniqueStrings(allRecords.map((entry) => entry.calendarEventId));
  const allEntries = allRecords.filter((entry) => entry.remindAtMs && entry.status !== "已读");
  const groups = new Map();
  const eventGroups = new Map();
  for (const entry of allEntries) {
    if (!entry.remindAtMs) continue;
    const key = String(entry.remindAtMs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
    if (entry.calendarEventId) {
      if (!eventGroups.has(entry.calendarEventId)) eventGroups.set(entry.calendarEventId, new Set());
      eventGroups.get(entry.calendarEventId).add(key);
    }
  }

  const result = [];
  const assignedEventIds = [];
  for (const [key, entries] of groups.entries()) {
    const preferredEventId = uniqueStrings(entries.map((entry) => entry.calendarEventId))
      .find((eventId) => eventGroups.get(eventId)?.size === 1) || "";
    const eventId = await refreshAggregateReadingCalendar(Number(key), preferredEventId, {
      preferredEventId,
      ignoreEntryEventIds: !preferredEventId,
      deleteStale: false
    });
    if (eventId) assignedEventIds.push(eventId);
    result.push({
      remindAtMs: Number(key),
      unread: entries.length,
      eventId
    });
  }

  const staleEventIds = allEventIds.filter((eventId) => !assignedEventIds.includes(eventId));
  for (const eventId of staleEventIds) {
    await deleteCalendarEvent(eventId).catch(() => {});
  }

  const clearedRecords = allRecords.filter((entry) => entry.calendarEventId && entry.status === "已读");
  for (const entry of clearedRecords) {
    await updateFeishuRecordWithCli(entry.recordId, {
      [fieldMap.calendarEventId]: null
    }).catch(() => {});
  }

  if (staleEventIds.length || clearedRecords.length) {
    result.push({
      cleanup: true,
      deletedEvents: staleEventIds.length,
      clearedRecords: clearedRecords.length
    });
  }

  return result;
}

async function listUnreadRecordsForReminder(remindAtMs = null, options = {}) {
  const records = await listRecordsForReminder();
  return records.filter((entry) => (
    entry.recordId !== options.excludeRecordId &&
    (remindAtMs == null || entry.remindAtMs === remindAtMs) &&
    entry.remindAtMs &&
    entry.status !== "已读"
  ));
}

async function listRecordsForReminder() {
  const projection = [
    fieldMap.title,
    fieldMap.url,
    fieldMap.status,
    fieldMap.remindAt,
    fieldMap.calendarEventId
  ];
  const entries = [];
  let offset = 0;

  while (true) {
    const args = [
      "base",
      "+record-list",
      "--base-token",
      env.LARK_APP_TOKEN,
      "--table-id",
      env.LARK_TABLE_ID,
      "--limit",
      "200",
      "--offset",
      String(offset),
      "--format",
      "json"
    ];
    for (const field of projection) {
      args.push("--field-id", field);
    }

    const result = await runCommand(larkCliCommand, args);
    const payload = parseJson(result.stdout);
    if (!payload || payload.ok === false) {
      const error = new Error(payload?.error?.message || result.stderr || "lark-cli record list failed");
      error.status = 502;
      throw error;
    }

    const fields = payload.data?.fields || [];
    const rows = payload.data?.data || [];
    const recordIds = payload.data?.record_id_list || [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = mapRecordRow(fields, rows[i]);
      const rowRemindAtMs = normalizeReminderTimeMs(row[fieldMap.remindAt]);
      const status = normalizeCellText(row[fieldMap.status]);
      const calendarEventId = normalizeCellText(row[fieldMap.calendarEventId]);
      if (rowRemindAtMs || calendarEventId) {
        entries.push({
          recordId: recordIds[i],
          remindAtMs: rowRemindAtMs,
          status,
          title: normalizeCellText(row[fieldMap.title]) || "未命名资料",
          url: extractUrl(normalizeCellText(row[fieldMap.url])),
          calendarEventId
        });
      }
    }

    if (!payload.data?.has_more) break;
    offset += rows.length || 200;
  }

  return entries;
}

function mapRecordRow(fields, row) {
  const mapped = {};
  for (let i = 0; i < fields.length; i += 1) {
    mapped[fields[i]] = row[i];
  }
  return mapped;
}

function normalizeReminderTimeMs(value) {
  if (typeof value === "number") return value;
  const text = normalizeCellText(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const normalized = text.replace(/-/g, "/");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function buildAggregateCalendarPayload(remindAtMs, entries) {
  const startSeconds = Math.floor(remindAtMs / 1000);
  const durationMinutes = Number(env.READING_EVENT_DURATION_MINUTES || 30);
  const endSeconds = startSeconds + Math.max(5, durationMinutes) * 60;
  const reminderMinutes = Number(env.READING_REMINDER_MINUTES || 0);
  const description = [
    `今天有 ${entries.length} 条发财资料待回看。点具体阅读入口后，该条会自动标记为已读。`,
    "",
    ...entries.map((entry, index) => {
      const readUrl = `http://127.0.0.1:${port}/read?record_id=${encodeURIComponent(entry.recordId)}`;
      return [
        `${index + 1}. ${trimText(entry.title, 72)}`,
        `阅读入口：${readUrl}`,
        entry.url ? `原始链接：${trimText(entry.url, 120)}` : ""
      ].filter(Boolean).join("\n");
    })
  ].join("\n\n").slice(0, 4000);

  return {
    summary: `回看：${entries.length} 条发财资料`.slice(0, 120),
    description,
    start_time: { timestamp: String(startSeconds), timezone: "Asia/Shanghai" },
    end_time: { timestamp: String(endSeconds), timezone: "Asia/Shanghai" },
    free_busy_status: "free",
    visibility: "private",
    reminders: [{ minutes: Number.isFinite(reminderMinutes) ? reminderMinutes : 5 }]
  };
}

function trimText(text, maxLength) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function createReadingCalendarEvent(payload) {
  const calendarId = await resolveCalendarId();
  const result = await runCommand(larkCliCommand, [
    "calendar",
    "events",
    "create",
    "--calendar-id",
    calendarId,
    "--data",
    JSON.stringify(payload),
    "--as",
    "user",
    "--format",
    "json"
  ]);
  const data = parseJson(result.stdout);
  if (!data || data.ok === false) {
    const error = new Error(data?.error?.message || result.stderr || "calendar create failed");
    error.status = 502;
    error.details = data || { stderr: result.stderr };
    throw error;
  }
  return data.data?.event || data.event || data.data || data;
}

async function patchCalendarEvent(eventId, payload) {
  const calendarId = await resolveCalendarId();
  const result = await runCommand(larkCliCommand, [
    "calendar",
    "events",
    "patch",
    "--calendar-id",
    calendarId,
    "--event-id",
    eventId,
    "--data",
    JSON.stringify(payload),
    "--as",
    "user",
    "--format",
    "json"
  ]);
  const data = parseJson(result.stdout);
  if (!data || data.ok === false) {
    const error = new Error(data?.error?.message || result.stderr || "calendar patch failed");
    error.status = 502;
    error.details = data || { stderr: result.stderr };
    throw error;
  }
  return data.data?.event || data.event || data.data || data;
}

function getCalendarEventId(event) {
  return event?.event_id || event?.data?.event?.event_id || "";
}

async function resolveCalendarId() {
  if (env.LARK_CALENDAR_ID && env.LARK_CALENDAR_ID !== "primary") return env.LARK_CALENDAR_ID;
  if (cachedPrimaryCalendarId) return cachedPrimaryCalendarId;
  const result = await runCommand(larkCliCommand, [
    "calendar",
    "calendars",
    "primary",
    "--as",
    "user",
    "--format",
    "json"
  ]);
  const data = parseJson(result.stdout);
  const entry = data?.data?.calendars?.[0];
  const calendarId = entry?.calendar?.calendar_id || entry?.calendar_id;
  if (!calendarId) throw new Error("Cannot resolve primary Feishu calendar.");
  cachedPrimaryCalendarId = calendarId;
  return calendarId;
}

async function deleteCalendarEvent(eventId) {
  if (!eventId) return;
  const calendarId = await resolveCalendarId();
  await runCommand(larkCliCommand, [
    "calendar",
    "events",
    "delete",
    "--calendar-id",
    calendarId,
    "--event-id",
    eventId,
    "--need-notification",
    "false",
    "--as",
    "user",
    "--format",
    "json"
  ]);
}

async function handleReadLink(url, res) {
  const recordId = url.searchParams.get("record_id");
  if (!recordId) {
    sendHtml(res, 400, "缺少 record_id", "这个阅读链接不完整。");
    return;
  }

  const record = await getFeishuRecordWithCli(recordId);
  const originalUrl = extractUrl(normalizeCellText(record[fieldMap.url]));

  await updateFeishuRecordWithCli(recordId, {
    [fieldMap.status]: "已读"
  });

  if (originalUrl && /^https?:\/\//.test(originalUrl)) {
    res.writeHead(302, { Location: originalUrl });
    res.end();
    return;
  }

  sendHtml(res, 200, "已标记为已读", "已更新飞书资料箱，但这条记录没有可跳转的原始链接。");
}

async function getFeishuRecordWithCli(recordId) {
  const result = await runCommand(larkCliCommand, [
    "base",
    "+record-get",
    "--base-token",
    env.LARK_APP_TOKEN,
    "--table-id",
    env.LARK_TABLE_ID,
    "--record-id",
    recordId,
    "--format",
    "json"
  ]);
  const payload = parseJson(result.stdout);
  if (!payload || payload.ok === false) {
    const error = new Error(payload?.error?.message || result.stderr || "lark-cli record get failed");
    error.status = 502;
    throw error;
  }

  const fields = payload.data?.fields || [];
  const row = payload.data?.data?.[0] || [];
  return mapRecordRow(fields, row);
}

function normalizeCellText(value) {
  if (Array.isArray(value)) return value.map(normalizeCellText).filter(Boolean).join(",");
  if (value && typeof value === "object") return value.text || value.name || value.id || "";
  return value == null ? "" : String(value);
}

function extractUrl(value) {
  const text = String(value || "").trim();
  const markdownMatch = text.match(/\]\((https?:\/\/[^)]+)\)/);
  if (markdownMatch) return markdownMatch[1];
  const rawMatch = text.match(/https?:\/\/\S+/);
  return rawMatch ? rawMatch[0] : "";
}


function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr || `${command} exited with ${code}`);
      error.status = 502;
      error.details = { code, stdout: parseJson(stdout) || stdout, stderr: parseJson(stderr) || stderr };
      reject(error);
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildFields(capture) {
  const fields = {
    [fieldMap.title]: capture.title,
    [fieldMap.url]: capture.url,
    [fieldMap.source]: capture.source,
    [fieldMap.coreContent]: capture.coreContent,
    [fieldMap.priority]: capture.priority,
    [fieldMap.status]: capture.status,
    [fieldMap.capturedAt]: capture.capturedAt
  };

  if (capture.tags.length > 0) {
    fields[fieldMap.tags] = env.TAGS_AS_TEXT === "true" ? capture.tags.join(", ") : capture.tags;
  }
  if (capture.remindAt) {
    fields[fieldMap.remindAt] = env.DATES_AS_TEXT === "true" ? capture.remindAt : capture.remindAtMs;
  }

  fields[fieldMap.capturedAt] = env.DATES_AS_TEXT === "true" ? capture.capturedAt : capture.capturedAtMs;

  for (const [key, value] of Object.entries(fields)) {
    if (value === "" || value == null || (Array.isArray(value) && value.length === 0)) {
      delete fields[key];
    }
  }

  return fields;
}

async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: env.LARK_APP_ID,
      app_secret: env.LARK_APP_SECRET
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    const error = new Error(data.msg || `Feishu token failed with HTTP ${response.status}`);
    error.status = 502;
    error.details = { code: data.code, msg: data.msg, requestId: data.request_id };
    throw error;
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expire || 7200) - 120) * 1000
  };
  return tokenCache.token;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, title, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;"><h1>${title}</h1><p>${body}</p></body>`);
}
