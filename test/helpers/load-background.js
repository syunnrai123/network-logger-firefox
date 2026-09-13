"use strict";

/**
 * 在 Node 里加载真实的 background.js 做测试。
 *
 * background.js 是普通的 MV2 后台脚本(不是模块),所以用 vm 提供一个最小的
 * WebExtension API 沙箱来求值。这样测试跑的是实际发布的文件本身,不需要为了
 * 可测性把它拆成模块,也就不存在"测的是另一份代码"的漂移风险。
 *
 * 顶层 `function` 声明会成为沙箱全局对象的属性,因此可以通过 harness.sandbox
 * 直接调用 sanitizeFilename / scrubUrl / buildEntry 等纯函数。顶层 `const` /
 * `let`(如 requests map)不会暴露,需要通过消息接口(onMessage)和 webRequest
 * 处理器来驱动 —— 这反而让集成测试覆盖了真实的调用路径。
 *
 * 注意:这个沙箱只适合验证**行为**,不要用它测**性能**。vm 上下文里的纯 JS
 * 循环比同进程常态慢一个数量级(实测同一函数 16MB 输入:沙箱内 2.4s,原生
 * realm 145ms),足以把"线性的手工扫描"误判成"性能退化"。宿主提供的原生实现
 * (RegExp / TextDecoder / TextEncoder)不受影响,所以正则类的对比仍然可用。
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BACKGROUND_PATH = path.join(__dirname, "..", "..", "background.js");
const EXTENSION_ID = "network-logger@test";

function loadBackground(options = {}) {
  const state = {
    badgeTexts: [],
    badgeColors: [],
    blobs: [],
    downloads: [],
    storage: {},
    storageWrites: [],
    filters: [],
    onMessage: null,
  };

  const noop = () => {};

  // 伪装 StreamFilter:ondata / onstop 由测试手动触发,同时记录写回页面的字节,
  // 用来验证"拷贝给 HAR 的同时原样转发"这个核心契约。
  function filterResponseData(requestId) {
    const filter = {
      requestId,
      ondata: null,
      onstop: null,
      onerror: null,
      writtenBytes: 0,
      closed: false,
      disconnected: false,
      write(data) { this.writtenBytes += data.byteLength; },
      close() { this.closed = true; },
      disconnect() { this.disconnected = true; },
    };
    if (options.onFilterCreated) options.onFilterCreated(filter);
    state.filters.push(filter);
    return filter;
  }

  const browser = {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: options.manifestVersion || "9.9.9" }),
      onMessage: { addListener: fn => { state.onMessage = fn; } },
    },
    webRequest: {
      filterResponseData,
      onBeforeRequest: { addListener: noop },
      onBeforeSendHeaders: { addListener: noop },
      onHeadersReceived: { addListener: noop },
      onBeforeRedirect: { addListener: noop },
      onCompleted: { addListener: noop },
      onErrorOccurred: { addListener: noop },
    },
    storage: {
      local: {
        get: () => Promise.resolve({ ...(options.initialStorage || {}), ...state.storage }),
        set: value => {
          state.storageWrites.push(value);
          Object.assign(state.storage, value);
          return Promise.resolve();
        },
      },
    },
    downloads: {
      download: opts => {
        state.downloads.push(opts);
        return Promise.resolve(state.downloads.length);
      },
      search: () => Promise.resolve([{ id: 1, state: options.downloadState || "complete" }]),
      onChanged: { addListener: noop, removeListener: noop },
    },
    action: {
      setBadgeText: opts => { state.badgeTexts.push(opts.text); },
      setBadgeBackgroundColor: opts => { state.badgeColors.push(opts.color); },
    },
  };

  // URL 需要同时保留构造函数能力(parseQueryString 里用 new URL)和 blob URL
  // 的截获能力 —— 只有拿到 Blob 才能校验导出的 HAR 是不是合法 JSON。
  class TestURL extends URL {}
  TestURL.createObjectURL = blob => {
    state.blobs.push(blob);
    return `blob:test/${state.blobs.length}`;
  };
  TestURL.revokeObjectURL = noop;

  const sandbox = {
    browser,
    URL: TestURL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    // btoa/atob 是宿主提供的全局(Firefox 后台页有),vm 里必须显式注入,
    // 否则 bytesToBase64 会抛 ReferenceError
    btoa,
    atob,
    Blob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, "utf8"), sandbox, { filename: BACKGROUND_PATH });

  const send = message => state.onMessage(message, { id: EXTENSION_ID });
  const sendFromUntrusted = message => state.onMessage(message, { id: EXTENSION_ID, tab: { id: 1 } });

  return { sandbox, state, send, sendFromUntrusted, browser };
}

/**
 * 触发一次完整的请求生命周期。
 * 直接调用 webRequest 处理器,顺序与 Firefox 真实事件顺序一致。
 */
function fireRequest(harness, spec = {}) {
  const {
    requestId = "1",
    url = "https://example.com/",
    method = "GET",
    type = "xmlhttprequest",
    tabId = 1,
    frameId = 0,
    startTime = 1000,
    requestBody,
    requestHeaders = [{ name: "host", value: "example.com" }],
    responseHeaders = [{ name: "content-type", value: "text/plain" }],
    statusCode = 200,
    statusLine = "HTTP/2 200",
    protocol = "HTTP/2",
    responseChunks = [],
    complete = true,
    wireSize,
  } = spec;

  const filtersBefore = harness.state.filters.length;
  harness.sandbox.onBeforeRequest({
    requestId, url, method, type, tabId, frameId, timeStamp: startTime, requestBody,
  });

  // image/media 等类型不会创建滤波器,此时必须区分"这次没建"和"用了上一次的"
  const filter = harness.state.filters.length > filtersBefore
    ? harness.state.filters[harness.state.filters.length - 1]
    : null;

  if (responseChunks.length && filter) {
    for (const chunk of responseChunks) filter.ondata({ data: chunk });
  }

  harness.sandbox.onBeforeSendHeaders({
    requestId, timeStamp: startTime + 5, requestHeaders,
  });

  const headers = wireSize === undefined
    ? responseHeaders
    : [...responseHeaders, { name: "content-length", value: String(wireSize) }];

  harness.sandbox.onHeadersReceived({
    requestId, timeStamp: startTime + 10, statusCode, statusLine, protocol, responseHeaders: headers,
  });

  if (complete) {
    harness.sandbox.onCompleted({
      requestId, timeStamp: startTime + 25, statusCode, statusLine, protocol,
      ip: "93.184.216.34", fromCache: false,
    });
  }

  if (filter) filter.onstop();

  return filter;
}

/** 触发导出并返回解析后的 HAR 对象(同时校验产物是合法 JSON)。 */
async function exportHAR(harness, extra = {}) {
  const result = await harness.send({ action: "downloadHAR", ...extra });
  const blob = harness.state.blobs[harness.state.blobs.length - 1];
  if (!blob) throw new Error("no blob captured — download never reached URL.createObjectURL");
  const raw = await blob.text();
  return { result, raw, har: JSON.parse(raw), download: harness.state.downloads.at(-1) };
}

/** 把任意文本编码成 filter.ondata 需要的 ArrayBuffer。 */
function chunk(text) {
  return new TextEncoder().encode(text).buffer;
}

module.exports = { loadBackground, fireRequest, exportHAR, chunk, EXTENSION_ID, BACKGROUND_PATH };
