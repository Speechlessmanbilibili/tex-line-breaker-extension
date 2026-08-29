# 更新/安装

正式版扩展 ID：`oicdbilhkpbjgbdbjklighpmkcbncfhp`。

## 首次安装 ZIP

1. 把 ZIP 解压到一个长期固定的目录。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式。
3. 选择“加载解压缩的扩展”，选中含 `manifest.json` 的目录。

## 更新

1. 使用新版 ZIP 覆盖同一目录中的旧文件。
2. 在扩展管理页找到 ID 为 `oicdbilhkpbjgbdbjklighpmkcbncfhp` 的 TeX Line Breaker。
3. 点击“重新加载”。

清单固定公钥且后续 CRX 继续使用同一私钥，因此正式发行 ID 不会随解压路径变化。当前版本仅使用正式固定 ID。

# v0.3.2

- 修复 Windows ZIP 条目分隔符错误导致 WASM 文件被解压成 `wasm�tex_line_breaker_core.wasm`、排版核心无法启动的问题。
- 标点压缩和悬挂结合当前实际字体的 advance 与墨迹边界，改善 System Font 等字体替换扩展启用后的断行兼容性。
- 提高闭标点后合法断点的优先级，尽量让标点悬挂而不是把“末字+标点”推到下一行。
- 字间调整从 token padding 改为末字符 `letter-spacing`，修复选择文字时仍出现背景缝隙的问题。
- 居中和右对齐块保留浏览器原生布局，避免被逐行重建强制改为左对齐。
- 弹窗可区分未注入与 WASM 核心加载失败，并覆盖 `about:blank`/源继承 frame。
# v0.3.1

- 字间伸缩和内部 Auto Spacing 改为附着在文字 token 上，消除选择文字时由独立 spacer 造成的白缝。
- 普通汉字之间不再允许负字距压缩；紧行只压缩空格和标点侧边空白，避免汉字重叠。
- 全角行末标点使用半字身悬挂，兼顾光学对齐和标点可见性。
- 对阻挡悬挂标点的祖先裁剪容器临时应用高优先级可见溢出，并在恢复原生布局时完整还原。
