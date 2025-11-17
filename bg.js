async function openApp() {
  // Abre la página empaquetada dentro de la extensión
  const url = chrome.runtime.getURL("index.html");
  await chrome.windows.create({ url, state: "maximized", focused: true });
}
chrome.runtime.onStartup.addListener(openApp);
chrome.runtime.onInstalled.addListener(openApp);