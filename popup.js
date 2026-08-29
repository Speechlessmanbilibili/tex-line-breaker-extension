async function send(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type }); document.getElementById("status").textContent = "已发送"; }
  catch { document.getElementById("status").textContent = "此页面不允许扩展注入"; }
}
document.getElementById("rerender").addEventListener("click", () => send("kp-rerender"));
document.getElementById("restore").addEventListener("click", () => send("kp-restore"));
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
