const form = document.querySelector("#captureForm");
const statusEl = document.querySelector("#status");
const submitButton = document.querySelector("#submitButton");

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageInfo = await getPageInfo(tab?.id);
  document.querySelector("#title").value = tab?.title || "";
  document.querySelector("#url").value = tab?.url || "";
  document.querySelector("#selectedText").value = pageInfo.selection || "";
  form.dataset.pageText = pageInfo.pageText || "";
  form.dataset.description = pageInfo.description || "";
  form.dataset.headings = JSON.stringify(pageInfo.headings || []);
  document.querySelector("#remindAt").value = tomorrowMorning();

  document.querySelector("#openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector("#remindAt").value = presetTime(button.dataset.preset);
    });
  });

  document.querySelector("#retryQueue").addEventListener("click", async () => {
    setStatus("重试中...");
    const result = await chrome.runtime.sendMessage({ type: "RETRY_QUEUE" });
    setStatus(`成功 ${result.saved} 条，剩余 ${result.remaining} 条`);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  setStatus("保存中...");

  const capture = {
    title: value("#title"),
    url: value("#url"),
    source: hostname(value("#url")),
    selectedText: value("#selectedText"),
    tags: value("#tags"),
    priority: value("#priority"),
    status: "未读",
    remindAt: value("#remindAt"),
    pageText: form.dataset.pageText || "",
    description: form.dataset.description || "",
    headings: JSON.parse(form.dataset.headings || "[]")
  };

  const response = await chrome.runtime.sendMessage({ type: "SAVE_CAPTURE", capture });
  submitButton.disabled = false;

  if (response?.ok) {
    setStatus("已保存到飞书");
    setTimeout(() => window.close(), 700);
  } else {
    setStatus(response?.error || "保存失败");
  }
});

async function getPageInfo(tabId) {
  if (!tabId) return {};
  try {
    const [result] = await chrome.scripting.executeScript({
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
    });
    return result?.result || {};
  } catch {
    return {};
  }
}

function value(selector) {
  return document.querySelector(selector).value.trim();
}

function setStatus(text) {
  statusEl.textContent = text;
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function presetTime(preset) {
  const date = new Date();
  if (preset === "none") return "";
  if (preset === "tonight") {
    date.setHours(21, 0, 0, 0);
    if (date.getTime() < Date.now()) date.setDate(date.getDate() + 1);
    return toInputValue(date);
  }
  if (preset === "weekend") {
    const day = date.getDay();
    const daysUntilSaturday = (6 - day + 7) % 7 || 7;
    date.setDate(date.getDate() + daysUntilSaturday);
    date.setHours(10, 0, 0, 0);
    return toInputValue(date);
  }
  return tomorrowMorning();
}

function tomorrowMorning() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return toInputValue(date);
}

function toInputValue(date) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
