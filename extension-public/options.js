const DEFAULT_CONFIG = {
  apiBaseUrl: "https://xrecall.netlify.app",
  sessionToken: "",
  baseUrl: ""
};

const statusEl = document.querySelector("#status");
const connectButton = document.querySelector("#connectButton");
const openBaseButton = document.querySelector("#openBaseButton");
const connectionText = document.querySelector("#connectionText");
const baseText = document.querySelector("#baseText");
const form = document.querySelector("#optionsForm");

init();

async function init() {
  await syncFromCallbackHash();
  const config = await getConfig();
  document.querySelector("#apiBaseUrl").value = config.apiBaseUrl;
  render(config);

  connectButton.addEventListener("click", () => connectFeishu(config));
  openBaseButton.addEventListener("click", () => {
    if (config.baseUrl) chrome.tabs.create({ url: config.baseUrl });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextConfig = {
      ...config,
      apiBaseUrl: document.querySelector("#apiBaseUrl").value.trim().replace(/\/$/, "")
    };
    await chrome.storage.sync.set({ config: nextConfig });
    statusEl.textContent = "已保存";
    render(nextConfig);
  });
}

async function connectFeishu(config) {
  statusEl.textContent = "正在打开飞书授权...";
  const redirectUri = chrome.identity.getRedirectURL("oauth");
  const url = new URL(`${config.apiBaseUrl}/api/auth/start`);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("extension_id", chrome.runtime.id);

  try {
    const callbackUrl = await launchWebAuthFlow(url.toString());
    await applyCallbackUrl(callbackUrl);
    const nextConfig = await getConfig();
    statusEl.textContent = "已连接飞书";
    render(nextConfig);
  } catch (error) {
    statusEl.textContent = error.message || "连接飞书失败";
  }
}

async function syncFromCallbackHash() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = hash.get("recall_token");
  if (!token) return;

  const config = await getConfig();
  const nextConfig = {
    ...config,
    sessionToken: token,
    baseUrl: hash.get("base_url") || config.baseUrl
  };
  await chrome.storage.sync.set({ config: nextConfig });
  history.replaceState(null, "", location.pathname);
}

async function applyCallbackUrl(callbackUrl) {
  const parsed = new URL(callbackUrl);
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const token = hash.get("recall_token");
  if (!token) throw new Error("飞书授权完成，但没有拿到 Recall token。");

  const config = await getConfig();
  await chrome.storage.sync.set({
    config: {
      ...config,
      sessionToken: token,
      baseUrl: hash.get("base_url") || config.baseUrl
    }
  });
}

function launchWebAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({
      url,
      interactive: true
    }, (callbackUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "飞书授权被取消。"));
        return;
      }
      if (!callbackUrl) {
        reject(new Error("飞书授权没有返回结果。"));
        return;
      }
      resolve(callbackUrl);
    });
  });
}

function render(config) {
  if (config.sessionToken) {
    connectionText.textContent = "已连接飞书";
    connectButton.textContent = "重新连接";
  } else {
    connectionText.textContent = "点击一次连接飞书，授权后即可一键收藏。";
    connectButton.textContent = "连接飞书";
  }

  if (config.baseUrl) {
    baseText.textContent = config.baseUrl;
    openBaseButton.disabled = false;
  } else {
    baseText.textContent = "连接后自动创建或绑定。";
    openBaseButton.disabled = true;
  }
}

async function getConfig() {
  const { config = {} } = await chrome.storage.sync.get("config");
  return { ...DEFAULT_CONFIG, ...config };
}
