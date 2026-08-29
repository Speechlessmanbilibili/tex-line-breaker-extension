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
# v0.3.1

- 字间伸缩和内部 Auto Spacing 改为附着在文字 token 上，消除选择文字时由独立 spacer 造成的白缝。
- 普通汉字之间不再允许负字距压缩；紧行只压缩空格和标点侧边空白，避免汉字重叠。
- 全角行末标点使用半字身悬挂，兼顾光学对齐和标点可见性。
- 对阻挡悬挂标点的祖先裁剪容器临时应用高优先级可见溢出，并在恢复原生布局时完整还原。
