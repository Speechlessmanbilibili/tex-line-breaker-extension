async function send(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const status = document.getElementById("status");
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type });
    if (response?.ok === false) {
      status.textContent = `扩展已注入，但无法执行：${response.error || "未知错误"}`;
      return;
    }
    status.textContent = type === "kp-restore" ? "已恢复原生布局" : "已请求重新排版";
  } catch (error) {
    status.textContent = `未找到页面排版实例：${error?.message || "消息发送失败"}`;
  }
}
document.getElementById("rerender").addEventListener("click", () => send("kp-rerender"));
document.getElementById("restore").addEventListener("click", () => send("kp-restore"));
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
