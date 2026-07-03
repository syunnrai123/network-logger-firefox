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
- 大体积响应会占用较多内存，因为导出 HAR 需要缓存响应体

## 来源声明

本项目是基于以下开源项目修改的 Firefox 兼容版本：

<https://github.com/themindfuel-ai/network-logger>

原项目名称、图标、界面与主要产品思路来自该项目。本版本的核心修改集中在 Firefox WebExtension 兼容、请求体/响应体捕获链路和导出行为适配。
