# Web Structure Archiver

这是一个重写后的 Chrome Manifest V3 扩展，用于：
- 扫描当前网页 DOM 结构
- 抓取外链 HTML/CSS/JS/图片/字体/音视频/图标等静态资源
- 将引用重写为本地相对路径
- 生成一个 `.zip` 压缩包下载

## 使用方式
1. 打开 `chrome://extensions`
2. 打开“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择本目录 `web-archiver-plugin`
5. 打开目标网页，点击扩展图标
6. 选择选项后点击“开始归档并下载”

## 导出内容
- `index.html`
- `assets/css`
- `assets/js`
- `assets/media`
- `assets/fonts`
- `metadata.json`

## 本次升级
- 修复 MV3 service worker 中 `URL.createObjectURL is not a function` 导致的下载失败
- 真正输出 `.zip`
- 更完整处理 `srcset`
- 更强处理 CSS 中的 `url(...)` 与 `@import`，并抓取字体/背景图
- 自动滚动页面触发懒加载后，再保留最终 DOM 状态进行归档

## 说明
- 优先保证网页结构和静态资源可落盘
- 动态接口返回内容、登录态依赖脚本执行结果、Service Worker 缓存、跨 iframe 深层页面，不保证完整镜像
- `.zip` 当前采用无压缩存储格式，但文件格式是真正的 zip，可直接打开


## 2.1.1
- 修复大页面在 `executeScript(...).result` 回传阶段失败，改为分块消息回传。


- 2.1.4 backport: 修复 freezeFormState 在部分 select 克隆节点上触发的 undefined is not iterable。


## 2.1.12 debuglog
- 默认在归档包中额外输出 debug.json。
- 记录标题文字样式、按钮样式、背景候选区块、图片状态、被移除节点、占位表单与搜索表单信息，便于后续针对样式/布局问题继续优化。

## 2.2.0 upgrade
- 优化轮播兼容：新增对 Slick / Swiper / Owl / Splide / Glide 的静态化展示兜底，避免只抓到单帧。
- 资源命名优化：自动解码 URL 编码文件名，避免出现 `Tung%20Wah%20Group%20Logo-1` 这类命名。
- 增强图片素材抓取：补充更多 `data-*` 懒加载字段与 `srcset` 候选资源采集。
- 样式保真增强：对轮播节点追加可见性与布局修复样式，减少导出后样式缺失。

## 2.3.0 options
- 新增“轮播导出模式”：视觉还原 / 素材完整（展开）。
- 新增“样式保真等级”：基础 / 高保真（可对关键可见节点追加 computed style 快照）。
- 新增“仅抓取图片素材”开关：自动关闭脚本与样式外链抓取，专注 assets/media 提取。
- 修复 includeMedia 开关与 images-only 的优先级逻辑，避免配置项失效。
- 轮播补丁样式改为作用在标记过的 carousel scope，降低对非轮播区域的误伤。

## 2.4.0 optimize
- `assets` 模式新增通用轮播结构静态化（网格化）兜底，不再只依赖 CSS 强制展示。
- 高保真样式快照改为“目标节点 + 上限计数”策略，降低大页面性能开销。
- 资源拉取新增重试与超时控制（针对 429/503/超时等临时失败）。
- 资源命名新增短哈希后缀，减少同名覆盖冲突。
- 增加 `tests/regression-smoke.mjs` 基础回归检查脚本。
- 修复 images-only 资源映射空路径问题，并增加按 URL 后缀识别图片资源的兜底逻辑。
