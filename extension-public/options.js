const DEFAULT_CONFIG = {
  apiBaseUrl: "https://xrecall.netlify.app",
  sessionToken: "",
  baseUrl: "",
  aiProvider: "openai",
  aiApiUrl: "https://api.openai.com/v1/chat/completions",
  aiModel: ""
};

const DEFAULT_SECRET_CONFIG = {
  aiApiKey: ""
};

const statusEl = document.querySelector("#status");
const connectButton = document.querySelector("#connectButton");
const connectionText = document.querySelector("#connectionText");
const aiForm = document.querySelector("#aiForm");
const aiProvider = document.querySelector("#aiProvider");
const customApiUrlLabel = document.querySelector("#customApiUrlLabel");
const startButton = document.querySelector("#startButton");
const openBaseButton = document.querySelector("#openBaseButton");

init();

async function init() {
  await syncFromCallbackHash();
  const config = await getConfig();
  const secretConfig = await getSecretConfig();
  aiProvider.value = config.aiProvider || "openai";
  document.querySelector("#aiApiUrl").value = config.aiApiUrl;
  document.querySelector("#aiApiKey").value = secretConfig.aiApiKey;
  toggleCustomApiUrl();
  render(config);

  connectButton.addEventListener("click", connectFeishu);
  aiProvider.addEventListener("change", toggleCustomApiUrl);
  startButton.addEventListener("click", () => window.close());
  openBaseButton.addEventListener("click", async () => {
    const latestConfig = await getConfig();
    if (latestConfig.baseUrl) chrome.tabs.create({ url: latestConfig.baseUrl });
  });

  aiForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const provider = aiProvider.value;
    const nextConfig = {
      ...(await getConfig()),
      aiProvider: provider,
      aiApiUrl: provider === "custom" ? document.querySelector("#aiApiUrl").value.trim() : "",
      aiModel: ""
    };
    const nextSecretConfig = {
      aiApiKey: document.querySelector("#aiApiKey").value.trim()
    };
    await chrome.storage.sync.set({ config: nextConfig });
    await chrome.storage.local.set({ secretConfig: nextSecretConfig });
    statusEl.textContent = nextSecretConfig.aiApiKey ? "模型设置已保存" : "模型设置已保存；未填 API Key 时会使用基础摘要";
    render(nextConfig);
  });
}

function toggleCustomApiUrl() {
  customApiUrlLabel.hidden = aiProvider.value !== "custom";
}

async function connectFeishu() {
  const config = await getConfig();
  statusEl.textContent = "正在打开飞书授权...";
  connectButton.textContent = "正在连接...";
  const redirectUri = chrome.identity.getRedirectURL("oauth");
  const url = new URL(`${config.apiBaseUrl}/api/auth/start`);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("extension_id", chrome.runtime.id);

  try {
    const callbackUrl = await launchWebAuthFlow(url.toString());
    await applyCallbackUrl(callbackUrl);
    const nextConfig = await getConfig();
    statusEl.textContent = "";
    render(nextConfig);
  } catch (error) {
    statusEl.textContent = error.message || "连接飞书失败";
    connectButton.textContent = "继续尝试连接";
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
  document.body.classList.toggle("connected", Boolean(config.sessionToken));
  openBaseButton.hidden = !config.baseUrl;
  if (config.sessionToken) {
    connectionText.textContent = "已连接飞书";
    connectButton.textContent = "重新连接";
  } else {
    connectionText.textContent = "点击一次连接飞书，授权后即可一键收藏。";
    connectButton.textContent = "连接飞书";
  }
}

async function getConfig() {
  const { config = {} } = await chrome.storage.sync.get("config");
  return { ...DEFAULT_CONFIG, ...config };
}

async function getSecretConfig() {
  const { secretConfig = {} } = await chrome.storage.local.get("secretConfig");
  return { ...DEFAULT_SECRET_CONFIG, ...secretConfig };
}
