# Network Logger - Firefox HAR Exporter

[中文](README.md) | [English](README_EN.md)

这是一个用于 Firefox 的网络请求记录插件，可以跨标签页捕获浏览器发出的网络请求，并导出为 HAR 1.2 文件。

本项目基于 [themindfuel-ai/network-logger](https://github.com/themindfuel-ai/network-logger) 修改而来，主要改造目标是兼容 Firefox，并保留原有的 HAR 导出使用体验。

## 主要功能

- 捕获 Firefox 中普通网页发出的网络请求
- 支持跨页面、跨标签页记录
- 导出标准 HAR 1.2 文件
- 捕获请求头、响应头、请求体和响应体
- 支持自定义导出文件名
- 可选清洗敏感数据

## Firefox 兼容改造

原项目主要依赖 Chrome MV3 的 `chrome.debugger` / CDP 能力获取完整网络数据。Firefox 扩展不提供同等的 Chrome Debugger API，因此本版本改为使用 Firefox WebExtension API：

- 使用 `webRequest.onBeforeRequest` 和 `requestBody` 捕获请求体
- 使用 `webRequest.filterResponseData()` 捕获响应体
- 使用 `downloads.download()` 导出 HAR 文件
- 使用 Manifest V2 的持久后台脚本

响应体捕获时，插件会复制响应流内容用于 HAR，同时把原始响应数据写回浏览器响应流，避免改变页面行为。

## 敏感数据处理

插件保留了敏感数据清洗功能，但默认不启用。

导出前只有在手动开启 `Scrub sensitive data` 选项时，才会清洗 cookies、tokens、passwords 等敏感信息。默认导出的 HAR 会保留原始请求体和响应体。

HAR 文件可能包含账号、密码、Token、Cookie 等敏感信息，请谨慎保存和分享。

## 安装与测试

### 临时加载到 Firefox

1. 打开 Firefox
2. 访问 `about:debugging#/runtime/this-firefox`
3. 点击 `Load Temporary Add-on...`
4. 选择本项目中的 `manifest.json`

### 使用 web-ext 运行

如果本机安装了 Node.js，可以使用 Mozilla 的 `web-ext`：

```powershell
npx --yes web-ext run --source-dir .
```

### 校验扩展

```powershell
npx --yes web-ext lint --source-dir .
```

当前版本已通过 Firefox 扩展校验：

- 0 errors
- 0 warnings

## 使用方式

1. 点击浏览器工具栏中的 Network Logger 图标
2. 点击 `Start Recording`
3. 在任意页面执行需要记录的操作
4. 点击 `Stop Recording`
5. 根据需要填写文件名、选择是否清洗敏感数据
6. 点击 `Export as HAR`

## 已知限制

- 开始录制之前已经发出的请求不会被捕获
- Firefox 内部页面、扩展页面、部分浏览器保留页面无法捕获
- 隐私窗口中的请求取决于 Firefox 是否允许该扩展在隐私窗口运行
- 单个响应体超过 50MB 或请求体超过 8MB 时会被截断保留（响应仍正常返回给页面，不影响浏览），导出时通过 `_bodyTruncated` / `postData._error` 标记说明
- 重定向链只记录初始 URL 与最终状态（webRequest API 不提供逐跳链路信息）
- 失败请求会以 `status: 0` 保留在 HAR 中，错误原因记录在 `response._error` 扩展字段
- 图片、媒体资源类型不缓存响应体（字体保留，供字体逆向使用），其 `content.size` 取自 content-length（可能为压缩后大小）

## 导出字段说明

为方便逆向分析，导出的 HAR 在标准字段外附带以下扩展字段（下划线前缀，HAR 消费者会忽略未知字段）：

- `request._resourceType` — 资源类型（image/script/xhr/font/websocket 等）
- 条目顶层 `_originUrl` / `_documentUrl` — 请求发起者来源与所在文档 URL
- 条目顶层 `_tabId` / `_frameId` / `_incognito` / `_thirdParty` — 请求归属上下文
- 条目顶层 `_ip` / `_fromCache` / `_proxyInfo` — 服务器 IP、是否命中缓存、代理信息
- `response._error` — 失败请求的错误原因（如 DNS 解析失败、连接被拒）
- `response.content._decodedFrom` — 原始传输编码（gzip/br），`content.text` 为解压后内容
- `response.content._bodySkipped` — 图片/媒体响应体按策略跳过捕获
- `response.content._bodyTruncated` — 响应体超过保留上限被截断，`content.text` 为截断后部分
- `request.postData._error` — 请求体捕获受限或被截断时的原因说明

`log.pages` 按标签页对请求分组，entry 通过 `pageref` 关联到对应 page。

## 来源声明

本项目是基于以下开源项目修改的 Firefox 兼容版本：

<https://github.com/themindfuel-ai/network-logger>

原项目名称、图标、界面与主要产品思路来自该项目。本版本的核心修改集中在 Firefox WebExtension 兼容、请求体/响应体捕获链路和导出行为适配。
