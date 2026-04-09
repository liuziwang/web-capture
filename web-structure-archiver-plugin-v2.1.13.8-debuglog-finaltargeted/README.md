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
