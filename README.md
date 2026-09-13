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

开启后会覆盖以下位置：

- 敏感请求头与响应头（`authorization`、`cookie`、`set-cookie`、`x-api-key` 等），以及 `cookies` 数组中的值
- 携带 URL 的头部（`referer`、`location`、`content-location`、`origin`）按 URL 规则脱敏 —— 魔法链接场景下落地页的 token 会随 Referer 出现在后续每个请求里
- URL 中的敏感 query 参数、**URL fragment**（`#access_token=…` 这类 OAuth implicit flow 与 hash 路由）、以及 `userinfo` 里的用户名密码
- 请求体与响应体文本中的 `Bearer` 凭据、JSON 字段与表单字段里的 password / token / secret
- 代理认证用户名

注意：脱敏是基于正则的尽力而为，无法覆盖自定义字段名或非标准编码的凭据。导出的 HAR 仍可能包含敏感信息，请谨慎保存和分享。

已知盲区（以下情况会漏，需要人工复核）：

- 参数名不在内置敏感名单里。名单刻意保守（如 OAuth 的 `code` 就没收录），避免与国家码 / 优惠码 / 状态码这类常见参数名冲突
- `Bearer` 凭据中间出现 base64url 字符集之外的字符（如 `%`、`:`）时，该字符之后的部分不会被清除（`Bearer abc%20def` → `[REDACTED]%20def`）
- JSON 值里含转义引号时（`"password":"he said \"hi\""`），第一个转义引号之后的内容不会被清除。改成转义感知的正则（`(?:[^"\\]|\\.)*`）会在超长（≥8MB）未闭合字符串上撑爆 regexp 回溯栈，反而把"局部泄露"升级为"整次导出失败"，因此保持现状
- `link` / `refresh` 等少见的 URL 型头部不在脱敏范围内

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

### 单元测试

测试直接对 `background.js` 求值（用 `vm` 提供最小的 WebExtension API 沙箱），跑的是实际发布的文件本身，不需要构建步骤，也没有第三方依赖：

```powershell
npm test
```

覆盖导出完整性（产物必须是合法 JSON 且条目数守恒）、HAR 规范字段、响应体文本 / base64 决策、文件名清理，以及脱敏路径（包括"开启脱敏后导出文件里不含任何明文凭据"的端到端断言）。

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
- 内存中最多保留 50000 条请求，超限后淘汰最早的请求，导出时通过 `log._droppedEntries` 记录被淘汰的条数。与响应体截断不同，条目淘汰后原始数据不再可恢复
- 响应体的文本 / base64 决策：明确是文本的 MIME（`text/*`、json、javascript、xml 等）在 16MB 以内解码为可读文本；其它类型在 1MB 以内且字节是合法 UTF-8 时也解码为文本，否则一律 base64（此时 `content.encoding` 为 `"base64"`）
- 重定向链只记录初始 URL 与最终状态（webRequest API 不提供逐跳链路信息）
- 失败请求会以 `status: 0` 保留在 HAR 中，错误原因记录在 `response._error` 扩展字段
- 图片、媒体资源类型不缓存响应体（字体保留，供字体逆向使用），其 `content.size` 取自 content-length（可能为压缩后大小）
- `timings` 中的 `blocked` / `dns` / `connect` / `ssl` 恒为 `-1`：webRequest API 不提供这些分段耗时
- 开启脱敏时，导出阶段要对每个文本响应体跑一遍正则清洗；16MB 量级的大文本体每个会增加约百毫秒的处理时间，导出期间后台线程会被占用

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
- `request.postData._error` — 请求体捕获受限或被截断时的原因说明（包括 multipart 上传中未随 raw 提供内容的文件段）
- `log._droppedEntries` — 因超出 50000 条上限而被淘汰的请求数；字段存在即表示这份 HAR 不完整

`response.content.size` 是解压后的内容大小，`response.bodySize` 是实际传输大小（取自 content-length，分块传输时退化为内容大小），两者之差记在 `response.content.compression`。

`log.pages` 按标签页对请求分组，entry 通过 `pageref` 关联到对应 page。

## 来源声明

本项目是基于以下开源项目修改的 Firefox 兼容版本：

<https://github.com/themindfuel-ai/network-logger>

原项目名称、图标、界面与主要产品思路来自该项目。本版本的核心修改集中在 Firefox WebExtension 兼容、请求体/响应体捕获链路和导出行为适配。

## 许可

本仓库当前**未附任何开源许可证**：上游 `themindfuel-ai/network-logger` 也未声明许可证，因此本衍生版本默认保留所有权利，仅适合本地个人使用，不具备公开再分发的授权基础。

如需公开发布或再分发，需要先确认上游作者是否授予许可，再在本仓库补一份 LICENSE（例如 MIT）并在 `manifest.json` / 文档中同步声明。

HAR 文件的敏感程度等同于账号凭据，请勿公开分享未脱敏的导出结果。
