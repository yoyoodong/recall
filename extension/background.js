var DEFAULT_CONFIG = {
  apiBaseUrl: "http://127.0.0.1:8787",
  apiKey: "",
  baseUrl: ""
};

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "save-to-feishu-capture",
      title: "保存到 Recall",
      contexts: ["page", "selection", "link"]
    });
    chrome.contextMenus.create({
      id: "open-feishu-capture-base",
      title: "打开 Recall 资料库",
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: "open-feishu-capture-options",
      title: "设置",
      contexts: ["action"]
    });
  });

  storageGet("sync", "config").then(function (data) {
    if (!data.config) {
      return storageSet("sync", { config: DEFAULT_CONFIG });
    }
    return null;
  });
});

chrome.action.onClicked.addListener(function (tab) {
  saveCurrentTab(tab);
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === "open-feishu-capture-base") {
    openBase();
    return;
  }
  if (info.menuItemId === "open-feishu-capture-options") {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId !== "save-to-feishu-capture") return;
  saveFromContext(info, tab);
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === "SAVE_CAPTURE") {
    var capture = message.capture || {};
    attachScreenshot(capture, sender && sender.tab)
      .then(saveCapture)
      .then(function (result) {
        return scheduleReminder(capture, result.record).then(function () {
          sendResponse({ ok: true, result: result });
          setTimeout(function () {
            showPageToast(sender && sender.tab && sender.tab.id, "发财💰+1");
          }, 850);
        });
      })
      .catch(function (error) {
        queueFailedCapture(message.capture, error).then(function () {
          sendResponse({ ok: false, error: error.message || "保存失败，已进入重试队列" });
        });
      });
    return true;
  }

  if (message && message.type === "RETRY_QUEUE") {
    retryQueue().then(function (result) {
      sendResponse(result);
    });
    return true;
  }

  return false;
});

function saveCurrentTab(tab) {
  var tabCapture = null;
  getPageInfo(tab && tab.id).then(function (pageInfo) {
    tabCapture = buildCaptureFromTab(tab, pageInfo);
    return savePreparedCapture(tabCapture, tab);
  }).then(function (result) {
    showPageToast(tab && tab.id, "发财💰+1");
    notify("已保存到飞书", result.capture.title || result.capture.url);
  }).catch(function (error) {
    queueFailedCapture(tabCapture || buildCaptureFromTab(tab, {}), error).then(function () {
      showPageToast(tab && tab.id, "保存失败：" + (error.message || "请检查本机服务"));
      notify("保存失败，已进入重试队列", error.message || "请检查本机服务和飞书配置");
    });
  });
}

function saveFromContext(info, tab) {
  var contextCapture = null;
  getPageInfo(tab && tab.id).then(function (pageInfo) {
    contextCapture = buildCaptureFromContext(info, tab, pageInfo);
    return savePreparedCapture(contextCapture, tab);
  }).then(function (result) {
    showPageToast(tab && tab.id, "发财💰+1");
    notify("已保存到飞书", result.capture.title || result.capture.url);
  }).catch(function (error) {
    queueFailedCapture(contextCapture || buildCaptureFromContext(info, tab, {}), error).then(function () {
      showPageToast(tab && tab.id, "保存失败：" + (error.message || "请检查本机服务"));
      notify("保存失败，已进入重试队列", error.message || "请检查本机服务和飞书配置");
    });
  });
}

function savePreparedCapture(capture, tab) {
  return attachScreenshot(capture, tab).then(saveCapture).then(function (result) {
    return scheduleReminder(capture, result.record).then(function () {
      return { capture: capture, result: result };
    });
  });
}

function saveCapture(capture) {
  return storageGet("sync", "config").then(function (data) {
    var config = data.config || DEFAULT_CONFIG;
    var apiBaseUrl = (config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl).replace(/\/$/, "");
    var headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["X-Capture-Key"] = config.apiKey;

    return fetch(apiBaseUrl + "/api/captures", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(capture)
    });
  }).then(function (response) {
    return response.json().catch(function () {
      return {};
    }).then(function (data) {
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "HTTP " + response.status);
      }
      return data;
    });
  });
}

function attachScreenshot(capture, tab) {
  if (!tab || !tab.windowId) return Promise.resolve(capture);
  return new Promise(function (resolve) {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }, function (dataUrl) {
      if (chrome.runtime.lastError || !dataUrl) {
        resolve(capture);
        return;
      }
      capture.screenshot = {
        dataUrl: dataUrl,
        name: screenshotName(capture)
      };
      resolve(capture);
    });
  });
}

function screenshotName(capture) {
  var source = hostname(capture.url) || "webpage";
  var timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return source + "-" + timestamp + ".jpg";
}

function scheduleReminder(capture, record) {
  return storageGet("sync", "config").then(function (data) {
    var config = data.config || DEFAULT_CONFIG;
    var apiBaseUrl = (config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl).replace(/\/$/, "");
    var headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["X-Capture-Key"] = config.apiKey;

    return fetch(apiBaseUrl + "/api/reminders/rebuild", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        remindAt: capture && capture.remindAt,
        recordId: record && (record.record_id || record.calendar_event_id || "")
      })
    }).then(function () {
      return null;
    }).catch(function () {
      return null;
    });
  });
}

function queueFailedCapture(capture, error) {
  return storageGet("local", "failedQueue").then(function (data) {
    var failedQueue = data.failedQueue || [];
    failedQueue.unshift({
      id: uniqueId(),
      capture: capture,
      error: error.message || "Unknown error",
      failedAt: new Date().toISOString()
    });
    return storageSet("local", { failedQueue: failedQueue.slice(0, 50) });
  });
}

function retryQueue() {
  return storageGet("local", "failedQueue").then(function (data) {
    var failedQueue = data.failedQueue || [];
    var remaining = [];
    var saved = 0;
    var chain = Promise.resolve();

    failedQueue.forEach(function (item) {
      chain = chain.then(function () {
        return saveCapture(item.capture)
          .then(function (result) {
            saved += 1;
            return scheduleReminder(item.capture, result.record);
          })
          .catch(function (error) {
            item.error = error.message || item.error;
            remaining.push(item);
          });
      });
    });

    return chain.then(function () {
      return storageSet("local", { failedQueue: remaining });
    }).then(function () {
      return { ok: true, saved: saved, remaining: remaining.length };
    });
  });
}

function buildCaptureFromContext(info, tab, pageInfo) {
  var url = info.linkUrl || (tab && tab.url) || "";
  var title = (tab && tab.title) || info.linkUrl || "未命名资料";
  pageInfo = pageInfo || {};
  var quickRead = buildQuickRead({
    title: title,
    url: url,
    selection: info.selectionText || pageInfo.selection || "",
    description: pageInfo.description || "",
    headings: pageInfo.headings || []
  });
  return {
    title: title,
    url: url,
    source: hostname(url),
    selectedText: quickRead,
    tags: inferTags({
      title: title,
      url: url,
      selection: info.selectionText || pageInfo.selection || "",
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

function buildCaptureFromTab(tab, pageInfo) {
  var url = (tab && tab.url) || "";
  pageInfo = pageInfo || {};
  var title = (tab && tab.title) || "未命名资料";
  return {
    title: title,
    url: url,
    source: hostname(url),
    selectedText: buildQuickRead({
      title: title,
      url: url,
      selection: pageInfo.selection || "",
      description: pageInfo.description || "",
      headings: pageInfo.headings || []
    }),
    tags: inferTags({
      title: title,
      url: url,
      selection: pageInfo.selection || "",
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
  var text = [
    info && info.title,
    info && info.url,
    info && info.description,
    info && info.selection,
    info && info.headings && info.headings.join(" "),
    info && info.pageText
  ].filter(Boolean).join(" ").toLowerCase();
  var tags = [];

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

  if (tags.length === 0) {
    tags.push("网页资料");
  }
  return tags.slice(0, 5);
}

function addTag(tags, tag, condition) {
  if (condition && tags.indexOf(tag) === -1) tags.push(tag);
}

function buildQuickRead(info) {
  var lines = [];
  lines.push("快读判断：" + toChineseReadingLine(info.title || "未命名资料", "这条资料值得快速扫一眼"));
  if (info.description) {
    lines.push("核心内容：" + toChineseReadingLine(info.description, "页面简介"));
  }
  if (info.selection) {
    lines.push("关键摘取：" + toChineseReadingLine(info.selection, "你选中的重点内容"));
  }
  if (info.headings && info.headings.length) {
    lines.push("阅读路径：" + info.headings.map(function (heading) {
      return toChineseReadingLine(heading, "小节");
    }).join(" / "));
  }
  lines.push("术语处理：专业名词、人名、产品名、论文名保留英文，必要时用中英双语。");
  lines.push("建议动作：先打开日历里的阅读入口，读完后自动标记已读。");
  lines.push("来源：" + hostname(info.url || ""));
  return lines.join("\n");
}

function toChineseReadingLine(text, fallback) {
  text = trimText(text || fallback, 260);
  if (!text) return fallback;
  return text;
}

function trimText(text, max) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

function defaultTomorrowMorning() {
  var date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return toLocalInputValue(date);
}

function toLocalInputValue(date) {
  function pad(number) {
    return String(number).padStart(2, "0");
  }
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.svg",
    title: title,
    message: String(message || "").slice(0, 180)
  });
}

function openBase() {
  storageGet("sync", "config").then(function (data) {
    var config = data.config || DEFAULT_CONFIG;
    chrome.tabs.create({ url: config.baseUrl || DEFAULT_CONFIG.baseUrl });
  });
}

function getPageInfo(tabId) {
  if (!tabId) return Promise.resolve({});
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function () {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () {
          var selection = window.getSelection ? String(window.getSelection()) : "";
          var description = "";
          var meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
          if (meta) description = meta.getAttribute("content") || "";
          var headings = Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3"), 0, 8)
            .map(function (node) { return (node.textContent || "").trim(); })
            .filter(Boolean);
          var source = document.querySelector("article, main, [role='main']") || document.body;
          var clone = source.cloneNode(true);
          Array.prototype.forEach.call(clone.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,button"), function (node) {
            node.remove();
          });
          var pageText = (clone.innerText || clone.textContent || "")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]{2,}/g, " ")
            .trim()
            .slice(0, 12000);
          return {
            selection: selection,
            description: description,
            headings: headings,
            pageText: pageText
          };
        }
      }, function (results) {
        if (chrome.runtime.lastError || !results || !results[0]) {
          resolve({});
          return;
        }
        resolve(results[0].result || {});
      });
    });
  });
}

function showPageToast(tabId, message) {
  if (!tabId) return;
  chrome.tabs.get(tabId, function () {
    if (chrome.runtime.lastError) return;
    var stickerUrl = chrome.runtime.getURL("assets/facai-sticker.png");
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (text, imageUrl) {
        if (!document.getElementById("feishu-capture-sticker-style")) {
          var style = document.createElement("style");
          style.id = "feishu-capture-sticker-style";
          style.textContent = [
            "@keyframes feishuCaptureStickerPop {",
            "0%{opacity:0;transform:translate3d(0,38px,0) scale(.72) rotate(-5deg)}",
            "16%{opacity:1;transform:translate3d(0,0,0) scale(1.07) rotate(2deg)}",
            "58%{opacity:1;transform:translate3d(0,-8px,0) scale(1) rotate(0deg)}",
            "100%{opacity:0;transform:translate3d(0,-62px,0) scale(.92) rotate(-1deg)}",
            "}",
            "@keyframes feishuCapturePlusOne {",
            "0%{opacity:0;transform:translate3d(12px,28px,0) scale(.35) rotate(-10deg)}",
            "20%{opacity:1;transform:translate3d(0,-2px,0) scale(1.18) rotate(5deg)}",
            "66%{opacity:1;transform:translate3d(0,-16px,0) scale(1) rotate(0deg)}",
            "100%{opacity:0;transform:translate3d(10px,-48px,0) scale(.86) rotate(4deg)}",
            "}"
          ].join("");
          document.documentElement.appendChild(style);
        }
        var old = document.getElementById("feishu-capture-toast");
        if (old) old.remove();
        var toast = document.createElement("div");
        toast.id = "feishu-capture-toast";
        toast.style.position = "fixed";
        toast.style.top = "36px";
        toast.style.right = "24px";
        toast.style.width = "210px";
        toast.style.height = "313px";
        toast.style.zIndex = "2147483647";
        toast.style.pointerEvents = "none";
        toast.style.transformOrigin = "65% 70%";
        toast.style.animation = "feishuCaptureStickerPop 1.75s cubic-bezier(.2,1.12,.32,1) forwards";

        var sticker = document.createElement("img");
        sticker.src = imageUrl;
        sticker.alt = "指定发财";
        sticker.style.position = "absolute";
        sticker.style.inset = "0";
        sticker.style.width = "100%";
        sticker.style.height = "100%";
        sticker.style.objectFit = "contain";
        sticker.style.filter = "drop-shadow(0 14px 18px rgba(63,28,8,.24))";

        var plus = document.createElement("div");
        plus.textContent = "+1";
        plus.style.position = "absolute";
        plus.style.top = "82px";
        plus.style.right = "5px";
        plus.style.color = "#ffb12b";
        plus.style.font = "900 46px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        plus.style.letterSpacing = "0";
        plus.style.webkitTextStroke = "2px #6b2b0d";
        plus.style.textShadow = "0 3px 0 #fff1b8, 0 8px 14px rgba(92,45,0,.25)";
        plus.style.animation = "feishuCapturePlusOne 1.35s cubic-bezier(.2,1.25,.35,1) .18s forwards";

        toast.appendChild(sticker);
        toast.appendChild(plus);
        document.documentElement.appendChild(toast);
        setTimeout(function () {
          if (toast.parentNode) toast.remove();
        }, 1900);
      },
      args: [message, stickerUrl]
    }, function () {
      if (chrome.runtime.lastError) return;
    });
  });
}

function storageGet(area, key) {
  return new Promise(function (resolve) {
    chrome.storage[area].get(key, function (data) {
      resolve(data || {});
    });
  });
}

function storageSet(area, value) {
  return new Promise(function (resolve) {
    chrome.storage[area].set(value, function () {
      resolve();
    });
  });
}

function uniqueId() {
  return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}
