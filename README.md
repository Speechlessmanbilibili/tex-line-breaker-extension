# TeX Line Breaker

独立的 Chromium Manifest V3 扩展。Rust/WASM 实现 TeX 风格 Knuth–Plass 段落断行，JavaScript 使用页面真实字体测量，并为中文/英文混排提供 CJK 微排版。

## 排版能力

- TeX box/glue/penalty 动态规划与四级 fitness class。
- `pretolerance`、允许 discretionary hyphenation 的 `tolerance`、`emergency stretch` 三遍求解。
- 按 WASM 结果精确分配字间/空格伸缩，不依赖浏览器再次自动断行。
- 前缀度量和可达状态剪枝使核心保持 O(n²) 候选搜索，避免长 CJK 段落退化到 O(n³)。
- CJK 行首/行末禁则、小假名/长音/重复符号禁则。
- CJK 标点挤压与连续标点压缩会结合当前实际字体的 glyph advance 和墨迹边界估算可压缩边白，兼容字体替换扩展造成的字体度量差异；普通汉字之间不使用负字距，避免字形相撞。
- 行首/行末悬挂标点/光学边缘对齐；全角句末标点采用半字身压缩+半字身悬挂，并提高标点后断行的算法优先级，能悬挂时不把“末字+标点”推到下一行。排版期间会对实际阻挡悬挂标点的祖先裁剪容器应用高优先级 `overflow: visible`，关闭或恢复原生布局时还原原值。
- 内置 en-US TeX hyphenation patterns；缺少其他语言词典时保持整词。
- 支持软连字符和 `<br>` 强制断行；仅在实际选中 discretionary breakpoint 时显示连字符。
- 基础行罚值、相邻行 fitness、连续断词、段末断词、过短末行、末行孤字 demerits。
- 保留链接、粗体、斜体等简单 inline DOM；关闭时完整恢复原节点。
- 居中和右对齐内容保留浏览器原生布局，不进入逐行重建，避免丢失原对齐方式或因悬挂宽度改变视觉中心。
- 字体加载、容器缩放和动态页面增量重排；字间调整附着到末字符的 `letter-spacing`，选区背景不会被 padding 分割出白缝。
- 正确处理 `text-indent`、站点直接修改已排版文本、SPA 删除节点和损坏的旧设置值。
- WASM fallback 或重建后检测到行溢出时立即恢复浏览器原生布局。

## 与 Auto Spacing 共存

中英文间距始终只有一个来源：

1. 最终 computed style 已启用 `text-autospace` 时，沿用页面或其他扩展的结果。
2. 未启用且 Chromium 支持时，只对正在排版的段落注入一次 `text-autospace: normal !important`。
3. 浏览器不支持时才使用内部 `0.125em` CJK/Western 间距，并将其纳入 KP 行宽计算。

恢复原生布局时会恢复原 inline `text-autospace`，不会与其他 Auto Spacing 实现叠加。内部补偿和 KP 字间伸缩都附着在文字 token 上，不插入可见空格，复制文本不变，选区背景也不会被独立 spacer 切出白缝。

## 设置与范围

- 全局开关默认关闭；站点规则优先于全局设置并匹配子域名。
- 可配置容差、紧急伸缩、拉伸/压缩、CJK 特性及各类 demerits。
- 自动跳过编辑器、代码、表格、媒体、flex/grid、RTL/bidi、伪元素生成文字、复杂 inline box 和超过 1600 排版单元的段落。
- 算法或测量失败时恢复浏览器原生布局。

这是段落级排版器，不是完整 TeX 文档系统。分页 widow/orphan、浮动体、脚注、数学排版、河流检测和字形轮廓级扩展不属于任意网页 content script 可可靠控制的范围；其中段落末尾的孤字/短行已用 demerits 做段落级等价约束。

## 构建

需要 Rust、`wasm32-unknown-unknown` target 和 Node.js：

```powershell
npm run build:wasm
npm test
cargo clippy --workspace --all-targets -- -D warnings
```

在 Chrome/Edge 的扩展管理页选择“加载解压缩的扩展”，加载仓库根目录。

## 正式发行 ID

从 v0.2.0 起清单固定公钥，v0.3.0 及后续正式发行 ID 为：

```text
oicdbilhkpbjgbdbjklighpmkcbncfhp
```

以后版本继续使用同一仓库外私钥打包，因此正式版会被浏览器识别为更新。私钥不进入 Git、GitHub Release 或安装 ZIP。

## 第三方数据

`hyphenation-en-us.js` 来源于 `hyphenation.en-us` 0.2.1 的 TeX patterns，作者 Bram Stein，BSD-3-Clause。详见 `THIRD_PARTY_NOTICES.md`。

## 许可证

GPL-3.0-or-later。
