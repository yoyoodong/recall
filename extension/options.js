const DEFAULT_CONFIG = {
  apiBaseUrl: "http://127.0.0.1:8787",
  apiKey: "",
  baseUrl: ""
};

const form = document.querySelector("#optionsForm");
const statusEl = document.querySelector("#status");

init();

async function init() {
  const { config = DEFAULT_CONFIG } = await chrome.storage.sync.get("config");
  document.querySelector("#apiBaseUrl").value = config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl;
  document.querySelector("#apiKey").value = config.apiKey || "";
  document.querySelector("#baseUrl").value = config.baseUrl || DEFAULT_CONFIG.baseUrl;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = {
    apiBaseUrl: document.querySelector("#apiBaseUrl").value.trim().replace(/\/$/, ""),
    apiKey: document.querySelector("#apiKey").value.trim(),
    baseUrl: document.querySelector("#baseUrl").value.trim()
  };
  await chrome.storage.sync.set({ config });
  statusEl.textContent = "已保存";
});
