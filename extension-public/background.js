const DEFAULT_CONFIG = {
  apiBaseUrl: "https://xrecall.netlify.app",
  sessionToken: "",
  baseUrl: "",
  aiProvider: "openai",
  aiApiUrl: "https://api.openai.com/v1/chat/completions",
  aiModel: "",
  aiApiKey: ""
};

const AI_PROVIDER_ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  kimi: "https://api.moonshot.ai/v1/chat/completions",
  zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  siliconflow: "https://api.siliconflow.cn/v1/chat/completions"
};

const AI_PROVIDER_MODELS = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  qwen: "qwen-plus",
  kimi: "kimi-k2.6",
  zhipu: "glm-4-flash",
  openrouter: "openai/gpt-4o-mini",
  siliconflow: "Qwen/Qwen2.5-7B-Instruct"
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "save-to-recall",
      title: "保存到 Recall",
      contexts: ["page", "selection", "link"]
    });
    chrome.contextMenus.create({
      id: "open-recall-options",
      title: "连接飞书 / 设置",
      contexts: ["action"]
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  saveCurrentTab(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-recall-options") {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === "save-to-recall") {
    saveFromContext(info, tab);
  }
});

async function saveCurrentTab(tab) {
  const config = await getConfig();
  if (!config.sessionToken) {
    openConnectPage();
    notify("需要连接飞书", "连接一次后，以后点击插件即可收藏。");
    return;
  }

  showPageToast(tab?.id);
  let capture = null;
  try {
    const pageInfo = await getPageInfo(tab?.id);
    capture = buildCaptureFromTab(tab, pageInfo);
    const result = await savePreparedCapture(capture, tab, config);
    notify("已保存到 Recall", "在飞书云文档搜索「看了会发财」查看。");
  } catch (error) {
    await queueFailedCapture(capture || buildCaptureFromTab(tab, {}), error);
    notify("保存失败", error.message || "请检查飞书连接");
  }
}

async function saveFromContext(info, tab) {
  const config = await getConfig();
  if (!config.sessionToken) {
    openConnectPage();
    notify("需要连接飞书", "连接一次后，以后右键也能收藏。");
    return;
  }

  showPageToast(tab?.id);
  let capture = null;
  try {
    const pageInfo = await getPageInfo(tab?.id);
    capture = buildCaptureFromContext(info, tab, pageInfo);
    const result = await savePreparedCapture(capture, tab, config);
    notify("已保存到 Recall", "在飞书云文档搜索「看了会发财」查看。");
  } catch (error) {
    await queueFailedCapture(capture || buildCaptureFromContext(info, tab, {}), error);
    notify("保存失败", error.message || "请检查飞书连接");
  }
}

async function savePreparedCapture(capture, tab, config) {
  capture.coreContent = await generateCoreContent(capture, config);
  await attachScreenshot(capture, tab);
  const result = await saveCapture(capture, config);
  if (result.baseUrl && result.baseUrl !== config.baseUrl) {
    await chrome.storage.sync.set({
      config: { ...config, baseUrl: result.baseUrl }
    });
  }
  return { capture, result };
}

async function saveCapture(capture, config) {
  const response = await fetch(`${config.apiBaseUrl}/api/captures`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.sessionToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(capture)
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    await chrome.storage.sync.set({
      config: { ...config, sessionToken: "" }
    });
    openConnectPage();
    throw new Error("飞书连接已失效，请重新连接。");
  }
  if (!response.ok || !data.ok) {
    throw new Error(formatApiError(data, response.status));
  }
  return data;
}

function formatApiError(data, status) {
  const parts = [];
  if (data?.error) parts.push(data.error);
  if (data?.code) parts.push(`code ${data.code}`);
  if (data?.details?.feishuMsg && data.details.feishuMsg !== data.error) parts.push(data.details.feishuMsg);
  if (data?.details?.feishuCode && data.details.feishuCode !== data.code) parts.push(`Feishu ${data.details.feishuCode}`);
  if (data?.details?.requestId) parts.push(`request ${data.details.requestId}`);
  return parts.filter(Boolean).join(" | ") || `HTTP ${status}`;
}

function attachScreenshot(capture, tab) {
  if (!tab || !tab.windowId) return Promise.resolve(capture);
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }, (dataUrl) => {
      if (!chrome.runtime.lastError && dataUrl) {
        capture.screenshot = {
          dataUrl,
          name: screenshotName(capture)
        };
      }
      resolve(capture);
    });
  });
}

function screenshotName(capture) {
  const source = hostname(capture.url) || "webpage";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${source}-${timestamp}.jpg`;
}

function buildCaptureFromContext(info, tab, pageInfo) {
  const url = info.linkUrl || tab?.url || "";
  const title = tab?.title || info.linkUrl || "未命名资料";
  return buildCapture(title, url, info.selectionText || pageInfo.selection || "", pageInfo);
}

function buildCaptureFromTab(tab, pageInfo) {
  const url = tab?.url || "";
  const title = tab?.title || "未命名资料";
  return buildCapture(title, url, pageInfo.selection || "", pageInfo);
}

function buildCapture(title, url, selection, pageInfo) {
  pageInfo = pageInfo || {};
  return {
    title,
    url,
    source: hostname(url),
    selectedText: selection,
    tags: inferTags({
      title,
      url,
      selection,
      description: pageInfo.description || "",
      headings: pageInfo.headings || [],
      pageText: pageInfo.pageText || ""
    }),
    priority: "普通",
    status: "未读",
    remindAt: defaultTomorrowMorning(),
    pageText: pageInfo.pageText || "",
    description: pageInfo.description || "",
    headings: pageInfo.headings || []
  };
}

function inferTags(info) {
  const text = [
    info.title,
    info.url,
    info.description,
    info.selection,
    info.headings?.join(" "),
    info.pageText
  ].filter(Boolean).join(" ").toLowerCase();
  const tags = [];
  addTag(tags, "视频", /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|video|视频|播客|podcast/.test(text));
  addTag(tags, "AI", /\bai\b|artificial intelligence|machine learning|llm|大模型|人工智能|agent/.test(text));
  addTag(tags, "代码", /github\.com|gitlab\.com|open source|开源|代码|repo/.test(text));
  addTag(tags, "论文", /arxiv\.org|doi\.org|paper|research|论文|研究|abstract/.test(text));
  addTag(tags, "产品工具", /product|tool|app|platform|工具|产品|平台|应用/.test(text));
  addTag(tags, "商业分析", /business|market|startup|funding|invest|商业|市场|创业|融资|投资/.test(text));
  addTag(tags, "教程方法", /guide|tutorial|how to|workflow|教程|指南|方法|工作流/.test(text));
  addTag(tags, "新闻资讯", /news|announced|launch|release|新闻|发布|宣布|更新/.test(text));
  if (!tags.length) tags.push("网页资料");
  return tags.slice(0, 5);
}

function addTag(tags, tag, condition) {
  if (condition && !tags.includes(tag)) tags.push(tag);
}

function getPageInfo(tabId) {
  if (!tabId) return Promise.resolve({});
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selection = window.getSelection?.().toString() || "";
        const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
        const source = document.querySelector("article, main, [role='main']") || document.body;
        const clone = source.cloneNode(true);
        clone.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,button").forEach((node) => node.remove());
        return {
          selection,
          description: meta?.getAttribute("content") || "",
          headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 8).map((node) => node.textContent.trim()).filter(Boolean),
          pageText: (clone.innerText || clone.textContent || "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim().slice(0, 12000)
        };
      }
    }, (results) => {
      if (chrome.runtime.lastError || !results?.[0]) {
        resolve({});
        return;
      }
      resolve(results[0].result || {});
    });
  });
}

function defaultTomorrowMorning() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function openConnectPage() {
  chrome.runtime.openOptionsPage();
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.svg",
    title,
    message: String(message || "").slice(0, 180)
  });
}

function showPageToast(tabId, failed) {
  if (!tabId) return;
  const stickerUrl = chrome.runtime.getURL("assets/facai-sticker.png");
  chrome.scripting.executeScript({
    target: { tabId },
    func: (imageUrl, isFailed) => {
      if (!document.getElementById("recall-sticker-style")) {
        const style = document.createElement("style");
        style.id = "recall-sticker-style";
        style.textContent = [
          "@keyframes recallStickerPop{0%{opacity:0;transform:translate3d(0,38px,0) scale(.72) rotate(-5deg)}16%{opacity:1;transform:translate3d(0,0,0) scale(1.07) rotate(2deg)}58%{opacity:1;transform:translate3d(0,-8px,0) scale(1)}100%{opacity:0;transform:translate3d(0,-62px,0) scale(.92) rotate(-1deg)}}",
          "@keyframes recallPlusOne{0%{opacity:0;transform:translate3d(12px,28px,0) scale(.35) rotate(-10deg)}20%{opacity:1;transform:translate3d(0,-2px,0) scale(1.18) rotate(5deg)}66%{opacity:1;transform:translate3d(0,-16px,0) scale(1)}100%{opacity:0;transform:translate3d(10px,-48px,0) scale(.86) rotate(4deg)}}"
        ].join("");
        document.documentElement.appendChild(style);
      }
      const old = document.getElementById("recall-toast");
      if (old) old.remove();
      const toast = document.createElement("div");
      toast.id = "recall-toast";
      toast.style.position = "fixed";
      toast.style.top = "36px";
      toast.style.right = "24px";
      toast.style.width = "210px";
      toast.style.height = "313px";
      toast.style.zIndex = "2147483647";
      toast.style.pointerEvents = "none";
      toast.style.animation = "recallStickerPop 1.75s cubic-bezier(.2,1.12,.32,1) forwards";
      const sticker = document.createElement("img");
      sticker.src = imageUrl;
      sticker.alt = "指定发财";
      sticker.style.position = "absolute";
      sticker.style.inset = "0";
      sticker.style.width = "100%";
      sticker.style.height = "100%";
      sticker.style.objectFit = "contain";
      sticker.style.filter = "drop-shadow(0 14px 18px rgba(63,28,8,.24))";
      const plus = document.createElement("div");
      plus.textContent = isFailed ? "!" : "+1";
      plus.style.position = "absolute";
      plus.style.top = "82px";
      plus.style.right = "5px";
      plus.style.color = isFailed ? "#ef4444" : "#ffb12b";
      plus.style.font = "900 46px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      plus.style.webkitTextStroke = "2px #6b2b0d";
      plus.style.textShadow = "0 3px 0 #fff1b8,0 8px 14px rgba(92,45,0,.25)";
      plus.style.animation = "recallPlusOne 1.35s cubic-bezier(.2,1.25,.35,1) .18s forwards";
      toast.appendChild(sticker);
      toast.appendChild(plus);
      document.documentElement.appendChild(toast);
      setTimeout(() => toast.remove(), 1900);
    },
    args: [stickerUrl, Boolean(failed)]
  });
}

async function queueFailedCapture(capture, error) {
  const { failedQueue = [] } = await chrome.storage.local.get("failedQueue");
  failedQueue.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    capture,
    error: error.message || "Unknown error",
    failedAt: new Date().toISOString()
  });
  await chrome.storage.local.set({ failedQueue: failedQueue.slice(0, 50) });
}

async function getConfig() {
  const { config = {} } = await chrome.storage.sync.get("config");
  const { secretConfig = {} } = await chrome.storage.local.get("secretConfig");
  return { ...DEFAULT_CONFIG, ...config, ...secretConfig };
}

async function generateCoreContent(capture, config) {
  const aiApiUrl = resolveAiApiUrl(config);
  if (!aiApiUrl || !config.aiApiKey) return "";

  const text = [
    capture.title ? `标题：${capture.title}` : "",
    capture.url ? `链接：${capture.url}` : "",
    capture.description ? `页面描述：${capture.description}` : "",
    capture.headings?.length ? `小标题：${capture.headings.join(" / ")}` : "",
    capture.selectedText ? `选中文本：${capture.selectedText}` : "",
    capture.pageText ? `正文：${capture.pageText}` : ""
  ].filter(Boolean).join("\n\n").slice(0, 16000);

  if (!text) return "";

  try {
    const response = await fetch(aiApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.aiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: resolveAiModel(config),
        messages: [
          {
            role: "system",
            content: "你是一个中文阅读助理。请用简洁、专业、可快速扫读的中文总结网页内容。专业名词、人名、产品名可保留英文或中英双语。不要编造网页没有的信息。"
          },
          {
            role: "user",
            content: [
              "请根据下面网页内容，输出适合写入飞书表格「核心内容」一列的内容。",
              "格式：",
              "精炼摘要：1-2句。",
              "核心观点：2-4条。",
              "值得看的点：1-3条。",
              "启发思考：1-2条。",
              "如果内容很少，就简短输出，不要硬凑。",
              "",
              text
            ].join("\n")
          }
        ],
        temperature: 0.2,
        max_tokens: 800
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return "";
    return String(data.choices?.[0]?.message?.content || "").trim().slice(0, 5000);
  } catch {
    return "";
  }
}

function resolveAiApiUrl(config) {
  if (config.aiProvider === "custom") return config.aiApiUrl || "";
  return AI_PROVIDER_ENDPOINTS[config.aiProvider || "openai"] || AI_PROVIDER_ENDPOINTS.openai;
}

function resolveAiModel(config) {
  return config.aiModel || AI_PROVIDER_MODELS[config.aiProvider || "openai"] || AI_PROVIDER_MODELS.openai;
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
