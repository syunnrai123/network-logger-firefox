/**
 * Network Logger - Firefox Background Script
 *
 * Firefox does not expose Chrome's debugger/CDP extension API. To keep the
 * same HAR-export behavior and still capture bodies, this implementation uses:
 *   - webRequest.onBeforeRequest with "requestBody" for request bodies.
 *   - webRequest.filterResponseData() for response streams.
 *
 * Every response chunk is copied for the HAR and immediately written back to
 * the browser stream, so page behavior is not changed.
 */

// --- API / State -------------------------------------------------------------
const api = typeof browser !== "undefined" ? browser : chrome;
const actionApi = api.action || api.browserAction;

const requests = new Map();          // webRequest requestId -> request data
const pendingBodyCaptures = new Set();
let isRecording = false;
let recordingStartTime = null;

// --- Feature Flags -----------------------------------------------------------
const FEATURES = {
  badge:          true,
  scrubbing:      true,
  customFilename: true,
  multiTab:       true,
  bodyCapture:    !!(api.webRequest && api.webRequest.filterResponseData),
};

// --- Badge ------------------------------------------------------------------
function ignoreResult(result) {
  if (result && typeof result.catch === "function") result.catch(() => {});
}

// Firefox badge 只容纳约 4 个字符,超出会被截断。4 位以内显示精确数字,
// 更大时压缩为 "9k+" 保证可读。
function badgeText(count) {
  return count > 9999 ? "9k+" : String(count);
}

function updateBadge() {
  if (!FEATURES.badge || !actionApi) return;

  if (isRecording) {
    const text = requests.size > 0 ? badgeText(requests.size) : "*";
    ignoreResult(actionApi.setBadgeText({ text }));
    ignoreResult(actionApi.setBadgeBackgroundColor({ color: "#ef4444" }));
  } else if (requests.size > 0) {
    ignoreResult(actionApi.setBadgeText({ text: badgeText(requests.size) }));
    ignoreResult(actionApi.setBadgeBackgroundColor({ color: "#10b981" }));
  } else {
    ignoreResult(actionApi.setBadgeText({ text: "" }));
  }
}

// --- Utilities ---------------------------------------------------------------
function isoString(ts) { return new Date(ts).toISOString(); }

function parseHeaders(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map(h => ({ name: String(h.name || ""), value: String(h.value ?? "") }));
  }
  if (typeof headers === "object") {
    return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  }
  return [];
}

function getHeaderValue(headers, headerName) {
  if (!headers) return "";
  const wanted = headerName.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find(h => String(h.name || "").toLowerCase() === wanted);
    return found ? String(found.value ?? "") : "";
  }
  const key = Object.keys(headers).find(k => k.toLowerCase() === wanted);
  return key ? String(headers[key] ?? "") : "";
}

// --- Cookie parsing ---------------------------------------------------------
// webRequest 不会在 HAR 的 cookies 字段中提供解析后的 cookie,只存在于
// 头字符串里,这里按 RFC 6265 的简化规则解析,满足 HAR 字段结构。
function parseRequestCookies(headers) {
  const value = getHeaderValue(headers, "cookie");
  if (!value) return [];
  return value.split(";").map(pair => {
    const idx = pair.indexOf("=");
    if (idx <= -1) return { name: pair.trim(), value: "" };
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
  });
}

function parseResponseCookies(headers) {
  if (!headers) return [];
  const list = Array.isArray(headers)
    ? headers
    : Object.entries(headers).map(([name, value]) => ({ name, value }));
  const out = [];
  for (const h of list) {
    if (String(h.name || "").toLowerCase() !== "set-cookie") continue;
    const parts = String(h.value ?? "").split(";");
    const first = parts.shift() || "";
    const idx = first.indexOf("=");
    if (idx <= -1) continue;
    const cookie = { name: first.slice(0, idx).trim(), value: first.slice(idx + 1).trim() };
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf("=");
      const key = (eq > -1 ? p.slice(0, eq) : p).toLowerCase();
      const val = eq > -1 ? p.slice(eq + 1).trim() : "";
      if (key === "path") cookie.path = val;
      else if (key === "domain") cookie.domain = val;
      else if (key === "expires") cookie.expires = val;
      else if (key === "max-age") cookie.maxAge = parseInt(val, 10) || 0;
      else if (key === "httponly") cookie.httpOnly = true;
      else if (key === "secure") cookie.secure = true;
      else if (key === "samesite") cookie.sameSite = val;
    }
    out.push(cookie);
  }
  return out;
}

function parseQueryString(url) {
  try {
    const params = [];
    new URL(url).searchParams.forEach((value, name) => params.push({ name, value }));
    return params;
  } catch {
    return [];
  }
}

function getContentType(headers) {
  const value = getHeaderValue(headers, "content-type");
  return value ? value.split(";")[0].trim().toLowerCase() : "application/octet-stream";
}

function getCharset(headers) {
  const value = getHeaderValue(headers, "content-type");
  const match = /;\s*charset=([^;]+)/i.exec(value);
  return match ? match[1].trim().replace(/^"|"$/g, "") : "utf-8";
}

function isTextContentType(mimeType) {
  if (!mimeType) return false;
  return mimeType.startsWith("text/") ||
    /(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv|svg)/i.test(mimeType);
}

function httpVer(protocol, statusLine) {
  const source = (protocol || statusLine || "").toLowerCase();
  if (source.includes("http/3") || source.includes("h3")) return "h3";
  if (source.includes("http/2") || source.includes("h2")) return "h2";
  return "HTTP/1.1";
}

function statusTextFor(code) {
  const map = {
    200: "OK", 201: "Created", 204: "No Content", 206: "Partial Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable"
  };
  return map[code] || "";
}

function statusTextFromLine(statusLine, statusCode) {
  if (!statusLine) return statusTextFor(statusCode);
  const match = /^HTTP\/\S+\s+\d+\s*(.*)$/i.exec(statusLine);
  return match && match[1] ? match[1] : statusTextFor(statusCode);
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function concatChunks(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function bytesToBase64(bytes) {
  // Build the binary string in chunked parts rather than a single spread
  // call. Each chunk is appended to an array and joined once, which avoids
  // creating a giant transient argument list and keeps peak memory lower
  // for large binary bodies. Output is byte-for-byte identical to a plain
  // fromCharCode loop (RFC 4648 base64).
  const chunkSize = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    parts.push(String.fromCharCode.apply(null, slice));
  }
  return btoa(parts.join(""));
}

function canDecodeUtf8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// 超过此阈值且非文本 MIME 的响应体不做文本解码探测,直接 base64:
// 1) 随机二进制字节可能恰好整体是合法 UTF-8,误判为文本会让二进制不可还原;
// 2) 省去对大字节数组的 UTF-8 探测与解码,降低 onstop 阶段的同步阻塞。
const MAX_DECODE_BODY_BYTES = 1024 * 1024;

function bytesToHarBody(bytes, headers) {
  const mimeType = getContentType(headers);
  if (bytes.byteLength > MAX_DECODE_BODY_BYTES && !isTextContentType(mimeType)) {
    return { text: bytesToBase64(bytes), encoded: true };
  }
  const shouldDecode = isTextContentType(mimeType) || canDecodeUtf8(bytes);

  if (shouldDecode) {
    // 优先按声明的 charset 解码
    let text;
    try {
      text = new TextDecoder(getCharset(headers), { fatal: false }).decode(bytes);
    } catch {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    // 声明编码解码出替换符(U+FFFD)而字节本身是合法 UTF-8 时回退 UTF-8,
    // 避免错误的 charset 声明让中文等文本整体变乱码。
    if (text.includes("�") && canDecodeUtf8(bytes)) {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    return { text, encoded: false };
  }

  return { text: bytesToBase64(bytes), encoded: true };
}

function sanitizeFilename(name) {
  let cleaned = name.replace(/\.har$/i, "").replace(/[<>:"/\\|?*]/g, "_").trim();
  if (!cleaned) cleaned = "network-log";
  // Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9),带任意扩展名也不合法
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]+)?$/i.test(cleaned)) cleaned = "_" + cleaned;
  // 文件名组件上限 ~255 字符(含 .har 扩展名),截断避免超长自定义名导致
  // downloads.download 直接报错而导出失败
  cleaned = cleaned.slice(0, 128);
  // Windows 会剥掉文件名末尾的点与空格,直接去掉避免"实际名与预期名不符"
  cleaned = cleaned.replace(/[. ]+$/, "");
  if (!cleaned) cleaned = "network-log";
  return cleaned;
}

// --- Body capture ------------------------------------------------------------
function extractRequestBody(requestBody) {
  const result = {
    text: null,
    encoding: null,
    size: 0,
    params: null,
    rawChunks: null,
    rawTotalBytes: 0,
    error: null
  };

  if (!requestBody) return result;
  if (requestBody.error) {
    result.error = requestBody.error;
    return result;
  }

  if (requestBody.raw && requestBody.raw.length) {
    const chunks = [];
    const fileParts = [];
    let totalBytes = 0;

    for (const part of requestBody.raw) {
      if (part.bytes) {
        const view = new Uint8Array(part.bytes);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        if (totalBytes + copy.byteLength > MAX_REQUEST_BODY_BYTES) {
          // 超限:丢弃剩余数据,标记错误让 HAR 说明请求体为何不完整
          result.error = `Request body truncated (exceeds ${MAX_REQUEST_BODY_BYTES} bytes)`;
          break;
        }
        chunks.push(copy);
        totalBytes += copy.byteLength;
      } else if (part.file) {
        fileParts.push(`[file:${part.file}]`);
      }
    }

    if (chunks.length) {
      result.rawChunks = chunks;
      result.rawTotalBytes = totalBytes;
      result.size = totalBytes;
    }

    if (fileParts.length && !chunks.length) {
      result.text = fileParts.join("\n");
      result.size = byteLength(result.text);
    }

    return result;
  }

  if (requestBody.formData) {
    const params = [];
    const searchParams = new URLSearchParams();
    for (const [name, values] of Object.entries(requestBody.formData)) {
      const list = Array.isArray(values) ? values : [values];
      for (const value of list) {
        const textValue = String(value);
        params.push({ name, value: textValue });
        searchParams.append(name, textValue);
      }
    }
    result.params = params;
    result.text = searchParams.toString();
    result.size = byteLength(result.text);
  }

  return result;
}

function finalizeRequestBody(request) {
  if (!request || !request.requestBodyRawChunks || request.requestPostData !== null) return;
  const bytes = concatChunks(request.requestBodyRawChunks, request.requestBodyRawTotalBytes);
  const body = bytesToHarBody(bytes, request.requestHeaders);
  request.requestPostData = body.text;
  request.requestPostDataEncoding = body.encoded ? "base64" : null;
  request.requestBodyRawChunks = null;
}

function finalizeResponseBody(request, chunks, totalBytes) {
  const bytes = concatChunks(chunks, totalBytes);
  const body = bytesToHarBody(bytes, request.responseHeaders);
  request.responseBody = body.text;
  request.responseBodyEncoded = body.encoded;
  request.responseBodySize = totalBytes;
}

// 不缓存这些资源类型的响应体。图片/媒体体积大且对文本分析无价值,跳过
// 可显著降低导出时的峰值内存。注意 onBeforeRequest 阶段无法得知最终 MIME,
// 因此这里按请求资源类型(而非 content-type)过滤。字体(font)必须保留:
// 字体逆向依赖 woff2 原始二进制,且通常 <100KB,内存代价可忽略。
const NON_BODY_TYPES = new Set(["image", "media"]);

// 单个响应体保留上限。超过后停止累积数据(但仍原样转发给页面,不影响浏览),
// 避免大文件下载(如 zip/octet-stream,不在 NON_BODY_TYPES 之列)把内存打爆。
// 逆向所需的典型响应体(JSON/HTML/JS)远小于此阈值。
const MAX_RESPONSE_BODY_BYTES = 50 * 1024 * 1024;

// 单个请求体提取上限。Firefox 对 requestBody.raw 本身有内置大小限制,但保留
// 一份显式保护,防止个别通道(如分块上传)把内存打爆。
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

function attachResponseFilter(requestId) {
  const request = requests.get(requestId);
  if (!request || !FEATURES.bodyCapture) return;
  if (NON_BODY_TYPES.has(request.type)) {
    // 标记"有响应体但按策略跳过",让 HAR 导出能说明为什么没有 text
    request.responseBodySkipped = true;
    return;
  }

  let filter;
  try {
    filter = api.webRequest.filterResponseData(requestId);
  } catch (err) {
    request.responseBodyError = err.message || String(err);
    return;
  }

  const chunks = [];
  let totalBytes = 0;

  // 兜底 timer 句柄:finish() 正常结束后必须清掉,否则每个请求都会遗留一个
  // 存活 10 分钟的 timer(录制上万请求即上万并发空转 timer)。
  let fallbackTimer;

  const captureDone = new Promise(resolve => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(fallbackTimer);
      try {
        finalizeResponseBody(request, chunks, totalBytes);
      } finally {
        pendingBodyCaptures.delete(captureDone);
        resolve();
      }
    };

    filter.ondata = event => {
      const data = event.data;
      if (!request.responseBodyTruncated && totalBytes + data.byteLength <= MAX_RESPONSE_BODY_BYTES) {
        const view = new Uint8Array(data);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        chunks.push(copy);
        totalBytes += copy.byteLength;
      } else if (!request.responseBodyTruncated) {
        // 达到上限:丢弃当前及后续数据块(只标记一次),内容仍原样转发给页面。
        request.responseBodyTruncated = true;
      }
      try {
        filter.write(data);
      } catch (err) {
        // 写回失败(流可能已关闭):记录原因,让 HAR 说明响应体为何缺失,
        // 避免异常中断 ondata 处理器导致 onstop/onerror 永不触发。
        request.responseBodyError = (err && err.message) ? err.message : String(err);
      }
    };

    filter.onstop = () => {
      try {
        filter.close();
      } catch {
        // The stream may already be closed.
      }
      finish();
    };

    filter.onerror = () => {
      request.responseBodyError = filter.error || "Stream filter error";
      try {
        filter.disconnect();
      } catch {
        // Ignore disconnect errors; the browser owns the response stream.
      }
      finish();
    };
  });

  request.bodyCapturePromise = captureDone;
  pendingBodyCaptures.add(captureDone);

  // 兜底:极端情况(如发起请求的标签页被立即关闭)下 onstop/onerror 可能都不
  // 触发,此时从 pending 集合移除标记,避免 waitForPendingBodies 无限等待。
  // 不调用 finish():onstop 未触发说明响应数据不完整,宁可不 finalize。
  fallbackTimer = setTimeout(() => { pendingBodyCaptures.delete(captureDone); }, 10 * 60 * 1000);
}

function waitForPendingBodies(timeoutMs = 10000) {
  if (!pendingBodyCaptures.size) return Promise.resolve();

  const pending = Promise.allSettled([...pendingBodyCaptures]);
  const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs));
  return Promise.race([pending, timeout]);
}

// --- HAR builder -------------------------------------------------------------
function buildEntry(r) {
  finalizeRequestBody(r);

  const send = Math.max(0, r.sendTime ?? 0);
  const wait = Math.max(0, r.waitTime ?? 0);
  const receive = Math.max(0, r.receiveTime ?? 0);
  const time = send + wait + receive;

  const reqHeaders = parseHeaders(r.requestHeaders);
  const respHeaders = parseHeaders(r.responseHeaders);

  const entry = {
    startedDateTime: isoString(r.startTime),
    time,
    request: {
      method:      r.method || "GET",
      url:         r.url || "",
      httpVersion: httpVer(r.protocol, r.statusLine),
      cookies:     parseRequestCookies(r.requestHeaders),
      headers:     reqHeaders,
      queryString: parseQueryString(r.url),
      headersSize: -1,
      bodySize:    r.requestBodySize ?? 0,
      // 资源类型(与 Chrome DevTools 导出的 _resourceType 同义),逆向归类请求类别
      _resourceType: r.resourceType
    },
    response: {
      status:      r.status || 0,
      statusText:  r.statusText || statusTextFor(r.status),
      httpVersion: httpVer(r.protocol, r.statusLine),
      cookies:     parseResponseCookies(r.responseHeaders),
      headers:     respHeaders,
      content: {
        size:     r.responseBodySize ?? 0,
        mimeType: getContentType(r.responseHeaders),
        // filterResponseData 提供的是解压后数据,text 是解压文本;记录原始
        // content-encoding 供逆向者判断传输编码(gzip/br),避免误读
        _decodedFrom: getHeaderValue(r.responseHeaders, "content-encoding") || null,
        _bodySkipped: !!r.responseBodySkipped,
        _bodyTruncated: !!r.responseBodyTruncated,
        _bodyError:   r.responseBodyError || null
      },
      redirectURL: r.redirectUrl || "",
      headersSize: -1,
      bodySize:    r.responseBodySize ?? 0
    },
    cache:   {},
    timings: { send, wait, receive },
    // --- 逆向上下文扩展字段(下划线前缀,HAR 消费者会忽略未知字段) ---
    _tabId:       r.tabId ?? -1,
    _frameId:     r.frameId ?? -1,
    _originUrl:   r.originUrl || null,
    _documentUrl: r.documentUrl || null,
    _incognito:   !!r.incognito,
    _thirdParty:  !!r.thirdParty,
    _ip:          r.ip || null,
    _fromCache:   !!r.fromCache,
    _proxyInfo:   r.proxyInfo || null
  };

  if (r.requestPostData !== null && r.requestPostData !== undefined) {
    entry.request.postData = {
      mimeType: getContentType(r.requestHeaders),
      text:     r.requestPostData
    };
    if (r.requestPostDataEncoding) entry.request.postData.encoding = r.requestPostDataEncoding;
    if (r.requestPostDataParams) entry.request.postData.params = r.requestPostDataParams;
    // 请求体被截断或捕获受限时说明原因,避免"看起来是完整 body 实际被砍"
    if (r.requestBodyError) entry.request.postData._error = r.requestBodyError;
  } else if (r.requestBodyError) {
    entry.request.postData = {
      mimeType: getContentType(r.requestHeaders) || "application/octet-stream",
      text: `[request body unavailable: ${r.requestBodyError}]`
    };
  }

  if (r.responseBody !== undefined) {
    entry.response.content.text = r.responseBody;
    if (r.responseBodyEncoded) entry.response.content.encoding = "base64";
  }

  // 失败请求没有 HTTP 状态码,HAR 规范无对应字段 —— 通过下划线扩展字段
  // 暴露 webRequest 记录的失败原因(DNS/连接/超时等),便于逆向调试定位。
  if (r.error) entry.response._error = r.error;

  return entry;
}

function buildHAR() {
  const entries = [];
  // 按 tabId 聚合成 HAR page(贴近 DevTools 导出习惯,逆向按标签页浏览)
  const pageOrder = [];       // 按首条请求时间排序的 tabId
  const pageInfo = new Map(); // tabId -> { startTime, title }
  requests.forEach(r => {
    // 保留所有已发起的请求,包括失败请求(status 为 0)——它们在逆向场景
    // 中同样有诊断价值,错误原因通过 entry.response._error 暴露。
    if (!r.url) return;
    const entry = buildEntry(r);
    entries.push(entry);
    if (typeof r.tabId === "number" && r.tabId >= 0) {
      let info = pageInfo.get(r.tabId);
      if (!info) {
        info = { startTime: r.startTime, title: null };
        pageInfo.set(r.tabId, info);
        pageOrder.push(r.tabId);
      }
      if (r.startTime < info.startTime) info.startTime = r.startTime;
      // 主框架导航请求的 URL 作为页面 title,后一次导航覆盖前一次
      if (r.type === "main_frame") info.title = r.url;
    }
  });
  pageOrder.sort((a, b) => pageInfo.get(a).startTime - pageInfo.get(b).startTime);
  const pages = pageOrder.map(tabId => {
    const info = pageInfo.get(tabId);
    return {
      startedDateTime: isoString(info.startTime),
      id: `page_${tabId}`,
      title: info.title || `Tab ${tabId}`,
      pageTimings: {}
    };
  });
  // 给 entries 打 pageref 关联到对应 page
  const idByTab = new Map(pageOrder.map((tabId, i) => [tabId, pages[i].id]));
  for (const entry of entries) {
    if (typeof entry._tabId === "number" && entry._tabId >= 0) {
      const pid = idByTab.get(entry._tabId);
      if (pid) entry.pageref = pid;
    }
  }
  // isoString() 输出固定格式的 UTC 时间串,字典序即时间序,直接字符串比较
  // 可避免为大日志(数万条目)反复构造 Date 对象。
  entries.sort((a, b) =>
    a.startedDateTime < b.startedDateTime ? -1 : a.startedDateTime > b.startedDateTime ? 1 : 0
  );

  const log = {
    version: "1.2",
    creator: { name: "Network Logger", version: "1.2.1" },
    entries
  };
  // 注意:downloadHARStream 用 JSON.stringify(log).slice(0,-1) 拼接 entries,
  // 空数组 `"pages":[]` 会被切成 `"pages":[` 导致非法 JSON,因此只有存在
  // page 时才输出 pages 字段。
  if (pages.length) log.pages = pages;
  return { log };
}

async function buildHARAfterBodyFlush() {
  await waitForPendingBodies();
  return buildHAR();
}

// --- Sensitive Data Scrubbing ------------------------------------------------
const REDACTED = "[REDACTED]";
// 纯字母脱敏值,用于 URL 查询串与结构化 params —— 不含方括号等会被
// URL 编码/规范化改写的字符,保证 URL 字符串与 queryString/params 数组
// 解析出来的脱敏值完全一致。
const REDACTED_URL_VALUE = "REDACTED";

const SENSITIVE_HEADERS = new Set([
  "authorization", "cookie", "set-cookie", "proxy-authorization",
  "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token",
  "x-access-token", "x-session-id", "www-authenticate", "proxy-authenticate"
]);

const SENSITIVE_BODY_PATTERNS = [
  /["']?[Bb]earer\s+[A-Za-z0-9_\-.~+\/]+=*["']?/g,
  /("(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token|session[_-]?id|csrf[_-]?token|xsrf[_-]?token)")\s*:\s*"[^"]*"/gi,
  /(?:password|passwd|secret|token|api_key|access_token|refresh_token|client_secret)=[^&\s]*/gi
];

const SENSITIVE_QUERY_PARAMS = new Set([
  "token", "access_token", "refresh_token", "api_key", "apikey",
  "key", "secret", "password", "passwd", "session_id", "csrf_token", "auth"
]);

function scrubHeaders(headers) {
  if (!headers || !Array.isArray(headers)) return headers;
  return headers.map(h =>
    SENSITIVE_HEADERS.has(String(h.name || "").toLowerCase())
      ? { name: h.name, value: REDACTED }
      : h
  );
}

function scrubCookies(cookies) {
  if (!cookies || !Array.isArray(cookies)) return cookies;
  return cookies.map(c => ({ ...c, value: REDACTED }));
}

function scrubJwtLike(text) {
  // JWT 三段落 base64url(不限定 eyJ 前缀,兼容非标准 header 的 token)。
  // 注意不能用无界贪婪的 /[A-Za-z0-9_-]{10,}\.\...\.../ —— 它会在不含
  // 点的长字符串上逐位置回溯,退化为 O(n²)(实测 100KB 需 8s+)。改为用
  // 前后边界锚定:每个 base64url 段只在起始边界处尝试匹配一次,整体线性。
  const JWT_RE = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})([^A-Za-z0-9_-]|$)/g;
  return text.replace(JWT_RE, (m, lead, _s1, _s2, _s3, trail) => lead + REDACTED + trail);
}

function scrubBodyText(text) {
  if (!text || typeof text !== "string") return text;
  let scrubbed = scrubJwtLike(text);
  for (const pattern of SENSITIVE_BODY_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, match => {
      const colonIdx = match.indexOf(":");
      if (colonIdx > -1 && match.startsWith('"')) {
        return match.substring(0, colonIdx + 1) + ` "${REDACTED}"`;
      }
      const eqIdx = match.indexOf("=");
      if (eqIdx > -1 && !match.startsWith("eyJ")) {
        return match.substring(0, eqIdx + 1) + REDACTED;
      }
      return REDACTED;
    });
  }
  return scrubbed;
}

function scrubUrl(url) {
  if (!url) return url;
  try {
    const qIdx = url.search(/[?#]/);
    const prefix = qIdx === -1 ? url : url.slice(0, qIdx);
    const rest = qIdx === -1 ? "" : url.slice(qIdx);
    const fragIdx = rest.indexOf("#");
    const queryStr = fragIdx > -1 ? rest.slice(0, fragIdx) : rest; // 含 '?'
    const fragment = fragIdx > -1 ? rest.slice(fragIdx) : "";
    let changed = false;

    // 1) query 敏感参数脱敏。只替换参数值,保留 URL 其余部分的原始字符串
    //    形式,不会把非敏感部分的字符表示规范化改写。
    const scrubbedQuery = queryStr
      ? queryStr.slice(1).split("&").map(pair => {
          if (!pair) return pair;
          const eq = pair.indexOf("=");
          const rawName = eq > -1 ? pair.slice(0, eq) : pair;
          let name = rawName;
          try { name = decodeURIComponent(rawName); } catch { /* 保留原始 name */ }
          if (SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) {
            changed = true;
            // 裸参数(无 =)也补上脱敏值,与 queryString 数组解析结果保持一致
            return `${rawName}=${REDACTED_URL_VALUE}`;
          }
          return pair;
        }).join("&")
      : "";

    // 2) userinfo 脱敏:scheme:// 之后、authority 结束(第一个 '/')之前的
    //    '@' 前是用户名[:密码]凭据,泄露即等于明文密码。注意必须在 query
    //    分支之外独立处理 —— 无 query 的 URL(如 `https://u:p@host/path`)
    //    之前会因 `qIdx === -1` 直接返回而漏掉。
    let scrubbedPrefix = prefix;
    const schemeEnd = prefix.indexOf("://");
    if (schemeEnd > -1) {
      const hostStart = schemeEnd + 3;
      const slash = prefix.indexOf("/", hostStart);
      const authorityEnd = slash === -1 ? prefix.length : slash;
      const at = prefix.indexOf("@", hostStart);
      if (at > -1 && at < authorityEnd) {
        scrubbedPrefix = prefix.slice(0, hostStart) + REDACTED_URL_VALUE + prefix.slice(at);
        changed = true;
      }
    }

    if (!changed) return url;
    return `${scrubbedPrefix}${queryStr ? `?${scrubbedQuery}` : ""}${fragment}`;
  } catch {
    return url;
  }
}

function scrubEntry(entry) {
  // buildEntry() already produces a fresh object tree: nested arrays
  // (headers, cookies, queryString) are newly allocated and string fields
  // are immutable, so assigning a scrubbed value creates a new string and
  // never mutates the original `requests` map entry. The previous
  // JSON.parse(JSON.stringify(entry)) deep clone was therefore redundant
  // and doubled peak memory during export — we now scrub in place. This
  // is safe even across repeated exports because each downloadHAR call
  // runs buildHAR() again and produces brand-new entry objects.
  entry.request.url = scrubUrl(entry.request.url);
  // 发起者 URL 同样可能携带敏感 query 参数,需一并脱敏
  if (entry._originUrl) entry._originUrl = scrubUrl(entry._originUrl);
  if (entry._documentUrl) entry._documentUrl = scrubUrl(entry._documentUrl);
  // 代理认证用户名敏感,覆盖为 REDACTED(创建新对象,不污染 requests map)
  if (entry._proxyInfo && entry._proxyInfo.username) {
    entry._proxyInfo = { ...entry._proxyInfo, username: REDACTED };
  }
  entry.request.headers = scrubHeaders(entry.request.headers);
  entry.request.cookies = scrubCookies(entry.request.cookies);
  if (entry.request.queryString) {
    entry.request.queryString = entry.request.queryString.map(q =>
      SENSITIVE_QUERY_PARAMS.has(q.name.toLowerCase())
        ? { name: q.name, value: REDACTED_URL_VALUE }
        : q
    );
  }
  if (entry.request.postData) {
    if (entry.request.postData.text && !entry.request.postData.encoding) {
      entry.request.postData.text = scrubBodyText(entry.request.postData.text);
    }
    // formData 解析出的结构化参数数组同样可能含密码/token 等敏感字段,
    // 与 queryString 采用相同的脱敏规则,否则 params 会泄露明文。
    if (Array.isArray(entry.request.postData.params)) {
      entry.request.postData.params = entry.request.postData.params.map(p =>
        SENSITIVE_QUERY_PARAMS.has(String(p.name || "").toLowerCase())
          ? { name: p.name, value: REDACTED_URL_VALUE }
          : p
      );
    }
  }
  entry.response.headers = scrubHeaders(entry.response.headers);
  entry.response.cookies = scrubCookies(entry.response.cookies);
  if (entry.response.content && entry.response.content.text && !entry.response.content.encoding) {
    entry.response.content.text = scrubBodyText(entry.response.content.text);
  }
  return entry;
}

// --- Firefox webRequest event handlers --------------------------------------
function onBeforeRequest(details) {
  if (!isRecording) return {};

  if (requests.size >= 50000) {
    const oldestKey = requests.keys().next().value;
    requests.delete(oldestKey);
  }

  const body = extractRequestBody(details.requestBody);
  requests.set(details.requestId, {
    tabId:              details.tabId,
    requestId:          details.requestId,
    url:                details.url,
    method:             details.method,
    type:               details.type,
    requestHeaders:     [],
    requestPostData:    body.text,
    requestPostDataEncoding: body.encoding,
    requestPostDataParams:   body.params,
    requestBodySize:    body.size,
    requestBodyError:   body.error,
    requestBodyRawChunks:     body.rawChunks,
    requestBodyRawTotalBytes: body.rawTotalBytes,
    startTime:          details.timeStamp,
    status:             0,
    statusText:         "",
    statusLine:         "",
    responseHeaders:    [],
    responseBodySize:   0,
    responseBody:       undefined,
    responseBodyEncoded:false,
    responseBodyError:  null,
    responseBodyTruncated: false,
    sendTime:           0,
    waitTime:           0,
    receiveTime:        0,
    protocol:           null,
    redirectUrl:        "",
    // --- 逆向上下文(details 直接提供,Firefox 均已支持) ---
    originUrl:          details.originUrl || null,   // 触发请求的来源 URL
    documentUrl:        details.documentUrl || null, // 请求所在文档 URL
    resourceType:       details.type || null,
    frameId:            details.frameId ?? -1,
    incognito:          !!details.incognito,
    thirdParty:         !!details.thirdParty,
    proxyInfo:          details.proxyInfo || null,
    fromCache:          false,
    ip:                 null
  });

  attachResponseFilter(details.requestId);
  updateBadge();
  return {};
}

function onBeforeSendHeaders(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.requestHeaders = details.requestHeaders || [];
  // HAR 的 timings.send 定义为"发送请求"耗时:从发起请求到头部发出的时间。
  r.sendTime = Math.max(0, details.timeStamp - r.startTime);
  // requestBody 捕获受限时(如 body 过大或未解析),用 content-length 兜底
  // bodySize,否则导出的 request.bodySize 会恒为 0。
  if (!r.requestBodySize) {
    const cl = getHeaderValue(details.requestHeaders, "content-length");
    if (cl) r.requestBodySize = parseInt(cl, 10) || 0;
  }
  finalizeRequestBody(r);
}

function onHeadersReceived(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.status = details.statusCode || r.status;
  r.statusLine = details.statusLine || r.statusLine;
  r.statusText = statusTextFromLine(details.statusLine, details.statusCode);
  r.responseHeaders = details.responseHeaders || [];
  r.waitTime = Math.max(0, details.timeStamp - r.startTime);
  // 对未捕获响应体(NON_BODY_TYPES)的请求,用 content-length 兜底记录大小;
  // 已捕获的请求会在 finalizeResponseBody 里用真实字节数覆盖此值。
  if (!r.responseBodySize) {
    const cl = getHeaderValue(details.responseHeaders, "content-length");
    if (cl) r.responseBodySize = parseInt(cl, 10) || 0;
  }
}

function onBeforeRedirect(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.status = details.statusCode || r.status;
  r.statusLine = details.statusLine || r.statusLine;
  r.statusText = statusTextFromLine(details.statusLine, details.statusCode);
  r.responseHeaders = details.responseHeaders || r.responseHeaders;
  r.redirectUrl = details.redirectUrl || "";
  r.receiveTime = Math.max(0, details.timeStamp - r.startTime - r.waitTime);
}

function onCompleted(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.status = details.statusCode || r.status;
  r.statusLine = details.statusLine || r.statusLine;
  r.statusText = statusTextFromLine(details.statusLine, details.statusCode);
  r.receiveTime = Math.max(0, details.timeStamp - r.startTime - r.waitTime);
  // 连接信息:服务器 IP 与是否命中缓存(判断"这请求是否真的走了网络")
  r.ip = details.ip || r.ip;
  r.fromCache = !!details.fromCache;
}

function onErrorOccurred(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.error = details.error || "Request failed";
  r.receiveTime = Math.max(0, details.timeStamp - r.startTime - r.waitTime);
  // 失败请求也能拿到目标 IP(DNS/连接阶段失败时可能为空)
  r.ip = details.ip || r.ip;
}

const allUrls = { urls: ["<all_urls>"] };
api.webRequest.onBeforeRequest.addListener(onBeforeRequest, allUrls, ["blocking", "requestBody"]);
api.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, allUrls, ["requestHeaders"]);
api.webRequest.onHeadersReceived.addListener(onHeadersReceived, allUrls, ["responseHeaders"]);
api.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, allUrls, ["responseHeaders"]);
api.webRequest.onCompleted.addListener(onCompleted, allUrls);
api.webRequest.onErrorOccurred.addListener(onErrorOccurred, allUrls);

// --- Download ----------------------------------------------------------------
// Streams the HAR out as a list of Blob parts instead of a single giant
// JSON string. The log header is serialized once; each entry is serialized
// on its own and appended to the parts array. Firefox may page large Blob
// data to a temporary file, so peak memory during export is roughly one
// entry's JSON plus the assembled Blob handle, instead of N full copies
// (object graph + giant string + Blob) of the whole capture.
async function downloadHARStream(har, filename) {
  const parts = [];

  // Serialize log metadata dynamically so any field buildHAR() adds to
  // har.log in the future (pages, comment, ...) is picked up automatically
  // instead of being silently dropped. Strip the trailing '}' from the
  // serialized metadata and splice in ',"entries":[' to reopen the array.
  const logMeta = { ...har.log };
  delete logMeta.entries;
  const logMetaJson = JSON.stringify(logMeta);
  const logOpen = logMetaJson === "{}"
    ? `{"entries":[`
    : `${logMetaJson.slice(0, -1)},"entries":[`;
  parts.push(`{"log":${logOpen}`);

  const entries = har.log.entries;
  let written = 0;
  // 每批让出主线程一次:JSON.stringify + 后续 Blob 拼接是同步热路径,数万
  // 条目时会长时间阻塞后台线程,期间 webRequest 事件与 popup 消息全部排队。
  // 录制已停止时 webRequest 事件不多,主要改善 popup 消息响应与内存碎片化。
  const BATCH_SIZE = 500;
  for (let i = 0; i < entries.length; i++) {
    const chunk = JSON.stringify(entries[i]);
    // JSON.stringify returns undefined only for top-level functions/symbols,
    // which would silently corrupt the array syntax — abort loudly instead
    // of shipping a truncated HAR.
    if (chunk === undefined) {
      const url = entries[i] && entries[i].request ? entries[i].request.url : "unknown";
      throw new Error(`Entry ${i} could not be serialized (${url})`);
    }
    // Newline-separated so each entry sits on its own line — keeps the file
    // scannable in a text editor without paying for 2-space indentation.
    parts.push(written === 0 ? "\n" : ",\n");
    parts.push(chunk);
    written++;
    if (written % BATCH_SIZE === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (written !== entries.length) {
    throw new Error(`HAR integrity check failed: wrote ${written} of ${entries.length} entries`);
  }

  parts.push("\n]}}");

  const blob = new Blob(parts, { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  let downloadId;
  try {
    downloadId = await api.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }

  // Revoke the blob URL when the download actually finishes (or fails)
  // instead of on a fixed 60s timer. This releases the underlying Blob
  // data as soon as the browser is done reading it — a 2-second download
  // no longer pins a multi-hundred-MB blob for a full minute. A safety
  // timeout catches cases where onChanged never fires (e.g. the saveAs
  // dialog is left open) so the listener doesn't leak indefinitely.
  // Note: revokeObjectURL() does NOT interrupt an in-flight transfer —
  // the browser holds its own reference once the download has started.
  const SAFETY_TIMEOUT_MS = 10 * 60 * 1000;
  let settled = false;
  let safetyTimer;
  let onChanged;

  // Revoke the blob URL and detach the listener. Called only when we know
  // the download has settled (onChanged reported complete/interrupted, or
  // a search confirmed the same) — at that point the browser has finished
  // reading the blob and revokeObjectURL() is safe.
  const revokeAndDetach = () => {
    if (settled) return;
    settled = true;
    clearTimeout(safetyTimer);
    try { api.downloads.onChanged.removeListener(onChanged); } catch {}
    URL.revokeObjectURL(url);
  };

  onChanged = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    const state = delta.state.current;
    if (state === "complete" || state === "interrupted") revokeAndDetach();
  };

  // Safety net for when onChanged never fires (Firefox bug 1344822: a
  // saveAs dialog left open can suppress the event). Query the current
  // state first: if the download has settled, revoke; otherwise just
  // remove the listener. We deliberately do NOT revoke while the download
  // is still in_progress — bug 2005952 shows that revoking a blob URL
  // before the transfer has started can abort the download (e.g. when the
  // user has Firefox set to "always ask where to save", which overrides
  // our saveAs:false). Conservative: prefer a leaked blob URL over an
  // aborted download, since this extension is used for reverse engineering
  // where data integrity matters more than prompt memory release.
  safetyTimer = setTimeout(async () => {
    if (settled) return;
    let currentState = null;
    try {
      const items = await api.downloads.search({ id: downloadId });
      currentState = items && items[0] && items[0].state;
    } catch {
      // Search failed — leave currentState null, fall through to the
      // conservative path below (detach only, do not revoke).
    }
    if (currentState === "complete" || currentState === "interrupted") {
      revokeAndDetach();
    } else {
      // Still in_progress or unknown — detach the listener but leave the
      // blob URL alive so a stalled download can still complete.
      settled = true;
      try { api.downloads.onChanged.removeListener(onChanged); } catch {}
    }
  }, SAFETY_TIMEOUT_MS);

  try {
    api.downloads.onChanged.addListener(onChanged);
    // Close the race: if the download already finished between download()
    // resolving and the listener attaching, query the current state once.
    const items = await api.downloads.search({ id: downloadId });
    const state = items && items[0] && items[0].state;
    if (state === "complete" || state === "interrupted") revokeAndDetach();
  } catch {
    // If search or addListener throws, the safety timer still detaches.
  }
}

// --- Message handler ---------------------------------------------------------
function isTrustedExtensionSender(sender) {
  return sender && sender.id === api.runtime.id && !sender.tab;
}

async function handleMessage(message, sender) {
  if (!isTrustedExtensionSender(sender)) {
    return { success: false, error: "Unauthorized sender" };
  }

  switch (message.action) {
    case "getStatus":
      return { isRecording, count: requests.size, startTime: recordingStartTime };

    case "getFeatures":
      return { features: FEATURES };

    case "startRecording":
      if (!isRecording) {
        requests.clear();
        // 上一会话若因响应流卡住走了 waitForPendingBodies 的 10s 超时,
        // pendingBodyCaptures 可能残留旧 promise;不清理会让本次会话导出时
        // 继续为已丢弃的旧响应白等。旧捕获的 finish() 仍会执行,但已不在
        // 集合中,delete/resolve 均为无害空操作。
        pendingBodyCaptures.clear();
        isRecording = true;
        recordingStartTime = Date.now();
        updateBadge();
        await api.storage.local.set({ isRecording: true, startTime: recordingStartTime });
      }
      return { success: true, isRecording: true };

    case "stopRecording":
      if (isRecording) {
        isRecording = false;
        await waitForPendingBodies();
        await api.storage.local.set({ isRecording: false });
        updateBadge();
      }
      return { success: true, isRecording: false, count: requests.size };

    case "clearRecording":
      requests.clear();
      pendingBodyCaptures.clear();
      isRecording = false;
      recordingStartTime = null;
      await api.storage.local.set({ isRecording: false });
      updateBadge();
      return { success: true };

    case "getCount":
      return { count: requests.size };

    case "exportHAR":
      return { har: await buildHARAfterBodyFlush() };

    case "downloadHAR": {
      const har = await buildHARAfterBodyFlush();
      if (FEATURES.scrubbing && message.scrubSensitive) {
        har.log.entries = har.log.entries.map(scrubEntry);
      }
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const baseName = (FEATURES.customFilename && message.customFilename)
        ? sanitizeFilename(message.customFilename)
        : `network-log-${ts}`;
      const filename = `${baseName}.har`;
      // downloadHARStream() owns the integrity check: it throws on entry-
      // count mismatch, serialization failure, or download API error.
      // Any throw propagates through handleMessage's catch to the popup.
      await downloadHARStream(har, filename);
      const failedCount = har.log.entries.reduce(
        (n, e) => n + ((e.response && e.response.status === 0) ? 1 : 0), 0);
      return { success: true, count: har.log.entries.length, failedCount };
    }

    default:
      return { success: false, error: "Unknown action" };
  }
}

api.runtime.onMessage.addListener((message, sender) =>
  handleMessage(message, sender).catch(err => ({
    success: false,
    error: err && err.message ? err.message : String(err)
  }))
);

// --- Restore state after background reload ----------------------------------
api.storage.local.get(["isRecording", "startTime"]).then(result => {
  if (result.isRecording) {
    isRecording = true;
    recordingStartTime = result.startTime || Date.now();
    updateBadge();
  } else if (actionApi) {
    ignoreResult(actionApi.setBadgeText({ text: "" }));
  }
});
