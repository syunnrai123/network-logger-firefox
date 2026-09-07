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
const initiatorQueues = new Map();   // tabId -> [{url, method, frames, via, t}]
const navLatest = new Map();         // tab:frame:url -> last restricted-nav requestId
let isRecording = false;
let recordingStartTime = null;
let liveEntries = 0;
let totalBodyBytes = 0;

const MAX_LIVE_ENTRIES = 50000;
const MAX_TOTAL_BODY_BYTES = 400 * 1024 * 1024;

// --- Feature Flags -----------------------------------------------------------
const FEATURES = {
  badge:          true,
  scrubbing:      true,
  customFilename: true,
  multiTab:       true,
  bodyCapture:    !!(api.webRequest && api.webRequest.filterResponseData),
  redirectChain:  true,
  callStack:      true,
  restrictedNav:  !!(api.webNavigation && api.webNavigation.onCommitted),
};

function recordedCount() {
  return liveEntries;
}

function storedBytes(r) {
  return (r._countedRequestBytes || 0) + (r._countedResponseBytes || 0);
}

function forgetRequest(key) {
  const r = requests.get(key);
  if (!r) return;
  // Drop this object from the HAR map but keep any live StreamFilter piping
  // bytes to the page. Bump generation so a late finish() does not count
  // the orphaned body against session totals.
  r.filterGeneration = (r.filterGeneration || 0) + 1;
  liveEntries -= 1 + (r.redirectHops && r.redirectHops.length ? r.redirectHops.length : 0);
  totalBodyBytes -= storedBytes(r);
  if (liveEntries < 0) liveEntries = 0;
  if (totalBodyBytes < 0) totalBodyBytes = 0;
  requests.delete(key);
}

function resetCaptureState() {
  // Invalidate in-flight StreamFilters from the previous session so a late
  // finish() cannot add bytes to the new session totals. Do not disconnect:
  // those filters must keep piping the response to the page.
  requests.forEach(r => {
    r.filterGeneration = (r.filterGeneration || 0) + 1;
  });
  requests.clear();
  pendingBodyCaptures.clear();
  initiatorQueues.clear();
  navLatest.clear();
  liveEntries = 0;
  totalBodyBytes = 0;
}

// --- Badge ------------------------------------------------------------------
function ignoreResult(result) {
  if (result && typeof result.catch === "function") result.catch(() => {});
}

// Firefox badge 空间约 4 个字符宽,但纯数字 4 位(如 "1234")在 Firefox 92+
// 起会因 badge max-width 收窄被裁掉末位,显示成 "123"(见 bugzilla 1733844
// / 1610063)。因此 3 位以内显示精确数字,4 位起改用 k 缩写 —— "1.2k" 这种
// 数字+点+字母的组合实际宽度小于四个等宽数字,可完整显示,不再丢末位。
function badgeText(count) {
  if (count < 1000) return String(count);
  if (count < 10000) {
    // 1000-9999:保留一位小数的 k("1.2k");整千时省略小数("1k")
    const k = (count / 1000).toFixed(1).replace(/\.0$/, "");
    return `${k}k`;
  }
  // 10000 以上:取整到 k("12k"),超过 9.9 万固定 "99k+" 防止超宽
  return count < 100000 ? `${Math.min(99, Math.round(count / 1000))}k` : "99k+";
}

function paintBadge() {
  if (!FEATURES.badge || !actionApi) return;
  const n = recordedCount();

  if (isRecording) {
    const text = n > 0 ? badgeText(n) : "*";
    ignoreResult(actionApi.setBadgeText({ text }));
    ignoreResult(actionApi.setBadgeBackgroundColor({ color: "#ef4444" }));
  } else if (n > 0) {
    ignoreResult(actionApi.setBadgeText({ text: badgeText(n) }));
    ignoreResult(actionApi.setBadgeBackgroundColor({ color: "#10b981" }));
  } else {
    ignoreResult(actionApi.setBadgeText({ text: "" }));
  }
}

// 每条请求都在 blocking 的 onBeforeRequest 里更新 badge 会打出大量 IPC。
// 录制中节流到 100ms 一次;start/stop/clear 传 immediate 立即刷新。
let badgePaintTimer = 0;
function updateBadge(immediate) {
  if (!FEATURES.badge || !actionApi) return;
  if (immediate) {
    if (badgePaintTimer) {
      clearTimeout(badgePaintTimer);
      badgePaintTimer = 0;
    }
    paintBadge();
    return;
  }
  if (badgePaintTimer) return;
  badgePaintTimer = setTimeout(() => {
    badgePaintTimer = 0;
    paintBadge();
  }, 100);
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

function cloneHeaders(headers) {
  return parseHeaders(headers);
}

function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return String(url || "");
  }
}

function parseStack(stack) {
  if (!stack) return [];
  const frames = [];
  for (const raw of String(stack).split("\n")) {
    if (frames.length >= 40) break;
    const line = raw.trim();
    if (!line || line === "Error") continue;
    if (line.includes("page-hook.js") || line.includes("content-hook.js")) continue;
    let m = /^(?:async\s*\*)?([^@]*)@(.+):(\d+):(\d+)$/.exec(line);
    if (m) {
      const file = m[2];
      if (file.includes("page-hook.js")) continue;
      frames.push({
        functionName: (m[1] || "").trim() || "<anonymous>",
        url: file,
        line: Number(m[3]),
        column: Number(m[4])
      });
      continue;
    }
    m = /^at\s+(?:(.+?)\s+\()?(\S+?):(\d+):(\d+)\)?$/.exec(line);
    if (m) {
      const file = m[2];
      if (file.includes("page-hook.js")) continue;
      frames.push({
        functionName: (m[1] || "").trim() || "<anonymous>",
        url: file,
        line: Number(m[3]),
        column: Number(m[4])
      });
    }
  }
  return frames;
}

function rememberInitiator(tabId, rec) {
  if (typeof tabId !== "number" || tabId < 0) return;
  let q = initiatorQueues.get(tabId);
  if (!q) {
    q = [];
    initiatorQueues.set(tabId, q);
  }
  q.push(rec);
  if (q.length > 300) q.splice(0, q.length - 300);
}

function takeInitiator(tabId, url, method, frameId) {
  const q = initiatorQueues.get(tabId);
  if (!q || !q.length) return null;
  const now = Date.now();
  const wantUrl = urlKey(url);
  const wantMethod = String(method || "GET").toUpperCase();
  const wantFrame = typeof frameId === "number" ? frameId : 0;
  for (let i = 0; i < q.length; i++) {
    const x = q[i];
    if (now - x.t > 5000) continue;
    if (x.method !== wantMethod) continue;
    if ((x.frameId ?? 0) !== wantFrame) continue;
    if (urlKey(x.url) !== wantUrl) continue;
    q.splice(i, 1);
    return x;
  }
  const kept = q.filter(x => now - x.t <= 5000);
  if (kept.length) initiatorQueues.set(tabId, kept);
  else initiatorQueues.delete(tabId);
  return null;
}

const selfBaseUrl = (() => {
  try { return api.runtime.getURL(""); } catch { return ""; }
})();

function isSelfUrl(url) {
  return !!(selfBaseUrl && url && String(url).startsWith(selfBaseUrl));
}

function isRestrictedUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  if (u === "about:blank" || u === "about:srcdoc") return false;
  return u.startsWith("about:") ||
    u.startsWith("moz-extension:") ||
    u.startsWith("chrome:") ||
    u.startsWith("resource:") ||
    u.startsWith("view-source:") ||
    u.startsWith("jar:");
}

function hopOrigin(r) {
  return r.hopStartTime || r.startTime;
}

function methodKeepsBody(method) {
  const m = String(method || "GET").toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

function ensureCapacity(protectId) {
  while (requests.size && (liveEntries >= MAX_LIVE_ENTRIES || totalBodyBytes >= MAX_TOTAL_BODY_BYTES)) {
    const oldestKey = requests.keys().next().value;
    if (oldestKey === undefined) break;
    if (protectId != null && oldestKey === protectId) {
      if (requests.size === 1) break;
      let skipped = null;
      for (const key of requests.keys()) {
        if (key !== protectId) {
          skipped = key;
          break;
        }
      }
      if (skipped == null) break;
      forgetRequest(skipped);
      continue;
    }
    forgetRequest(oldestKey);
  }
}

async function getIncognitoAllowed() {
  if (!api.extension || typeof api.extension.isAllowedIncognitoAccess !== "function") return null;
  try {
    return await api.extension.isAllowedIncognitoAccess();
  } catch {
    return null;
  }
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
  const cookies = [];
  for (const pair of value.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue; // 连续分号("a=b;;c=d")会产生空段,跳过
    const idx = trimmed.indexOf("=");
    if (idx <= -1) {
      cookies.push({ name: trimmed, value: "" });
    } else {
      cookies.push({ name: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
    }
  }
  return cookies;
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
      else if (key === "expires") {
        // HAR 1.2 的 expires 是 ISO 8601;解析失败则保留原值以免丢信息
        const ms = Date.parse(val);
        cookie.expires = Number.isNaN(ms) ? val : new Date(ms).toISOString();
      }
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
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "utf-8";
}

function isTextContentType(mimeType) {
  if (!mimeType) return false;
  if (mimeType.startsWith("text/")) return true;
  // RFC 6838 structured syntax suffixes, e.g. application/vnd.api+json
  if (mimeType.endsWith("+json") || mimeType.endsWith("+xml")) return true;
  switch (mimeType) {
    case "application/json":
    case "application/xml":
    case "application/javascript":
    case "application/ecmascript":
    case "application/x-javascript":
    case "application/x-ecmascript":
    case "application/x-www-form-urlencoded":
    case "application/graphql":
    case "application/csv":
    case "image/svg+xml":
      return true;
    default:
      return false;
  }
}

function httpVer(protocol, statusLine) {
  const source = (protocol || statusLine || "").toLowerCase();
  if (source.includes("http/3") || source.includes("h3")) return "HTTP/3";
  if (source.includes("http/2") || source.includes("h2")) return "HTTP/2";
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

// 文本体超过此阈值一律 base64,避免大 text/plain 在 onstop 阶段做 UTF-8
// 探测+解码时峰值内存约为源字节数的数倍。非文本 MIME 无论大小都走 base64,
// 不会因为碰巧是合法 UTF-8(如 "PNG" 三字节)被误当成文本。
const MAX_DECODE_BODY_BYTES = 1024 * 1024;

function bytesToHarBody(bytes, headers) {
  const mimeType = getContentType(headers);
  if (bytes.byteLength === 0) return { text: "", encoded: false };
  if (bytes.byteLength > MAX_DECODE_BODY_BYTES || !isTextContentType(mimeType)) {
    return { text: bytesToBase64(bytes), encoded: true };
  }

  // 优先按 UTF-8 解码:现代站点普遍输出 UTF-8。仅当字节不是合法 UTF-8
  // (canDecodeUtf8 为 false,如 GBK/Shift_JIS 编码的中文)时才信任声明的
  // charset。这样 iso-8859-1 / windows-1252 等单字节编码的声明不会把合法
  // UTF-8 的中文静默解成乱码 —— 这类编码解码永不出 U+FFFD 替换符,
  // 旧的 `includes("�")` 回退条件对它们完全失效。
  const isUtf8 = canDecodeUtf8(bytes);
  let text;
  if (isUtf8) {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } else {
    try {
      text = new TextDecoder(getCharset(headers), { fatal: false }).decode(bytes);
    } catch {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
  }
  return { text, encoded: false };
}

function sanitizeFilename(name) {
  // \x00-\x1f / DEL(\x7f) 是 Windows 文件名非法控制字符,删除比替换更安全
  let cleaned = name
    .replace(/\.har$/i, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  if (!cleaned) cleaned = "network-log";
  // Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9)。按第一个 '.' 前的
  // stem 判断,这样 CON.tar.gz 这类多段扩展名也会被挡住。
  const stem = cleaned.split(".")[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) cleaned = "_" + cleaned;
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
        if (totalBytes + view.byteLength > MAX_REQUEST_BODY_BYTES) {
          // 超限:先判断再拷贝,避免单块远超上限时在 blocking 路径上白分配
          result.error = `Request body truncated (exceeds ${MAX_REQUEST_BODY_BYTES} bytes)`;
          break;
        }
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
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
    let encodedSize = 0;
    let truncated = false;
    for (const [name, values] of Object.entries(requestBody.formData)) {
      if (truncated) break;
      const list = Array.isArray(values) ? values : [values];
      for (const value of list) {
        const textValue = String(value);
        const sep = params.length ? 1 : 0;
        const piece = sep + byteLength(encodeURIComponent(name)) + 1 + byteLength(encodeURIComponent(textValue));
        if (encodedSize + piece > MAX_REQUEST_BODY_BYTES) {
          result.error = `Request body truncated (exceeds ${MAX_REQUEST_BODY_BYTES} bytes)`;
          truncated = true;
          break;
        }
        encodedSize += piece;
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
  totalBodyBytes -= request._countedResponseBytes || 0;
  request._countedResponseBytes = totalBytes;
  totalBodyBytes += totalBytes;
  if (totalBodyBytes < 0) totalBodyBytes = 0;
  if (totalBodyBytes >= MAX_TOTAL_BODY_BYTES) ensureCapacity(request.requestId);
}

// 不缓存这些资源类型的响应体。图片/媒体体积大且对文本分析无价值,跳过
// 可显著降低导出时的峰值内存。注意 onBeforeRequest 阶段无法得知最终 MIME,
// 因此这里按请求资源类型(而非 content-type)过滤。字体(font)必须保留:
// 字体逆向依赖 woff2 原始二进制,且通常 <100KB,内存代价可忽略。
const NON_BODY_TYPES = new Set(["image", "imageset", "media"]);

// 单个响应体保留上限。超过后停止累积数据(但仍原样转发给页面,不影响浏览),
// 避免大文件下载(如 zip/octet-stream,不在 NON_BODY_TYPES 之列)把内存打爆。
// 逆向所需的典型响应体(JSON/HTML/JS)远小于此阈值。
const MAX_RESPONSE_BODY_BYTES = 50 * 1024 * 1024;

// 单个请求体提取上限。Firefox 对 requestBody.raw 本身有内置大小限制,但保留
// 一份显式保护,防止个别通道(如分块上传)把内存打爆。
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

function isDeadFilterError(err) {
  const s = String(err || "").toLowerCase();
  return s.includes("invalid request id") ||
    s.includes("channel redirected") ||
    s.includes("invalidchannel");
}

function isInternalRedirectHop(hop) {
  if (!hop) return false;
  const status = hop.status || 0;
  const headers = hop.responseHeaders || [];
  // HSTS / HTTPS upgrade: onBeforeRedirect fires with no real HTTP response.
  if (status === 0) return true;
  if (status < 300 && headers.length === 0) return true;
  return false;
}

function shouldReattachFilter(existing) {
  if (!FEATURES.bodyCapture) return false;
  if (existing.responseBodySkipped) return false;
  if (NON_BODY_TYPES.has(existing.type)) return false;
  if ((existing._countedResponseBytes || 0) > 0) return false;
  if (isDeadFilterError(existing.responseBodyError)) return true;
  const hops = existing.redirectHops || [];
  const last = hops[hops.length - 1];
  if (isInternalRedirectHop(last)) return true;
  // Continuation before onBeforeRedirect: only treat as STS if the first hop
  // never sent headers. A real HTTP 302 has already gone through
  // onBeforeSendHeaders.
  if (!hops.length &&
      !(existing.requestHeaders && existing.requestHeaders.length) &&
      !existing.sendTime) {
    return true;
  }
  return false;
}

function releaseStreamFilter(request) {
  request.filterGeneration = (request.filterGeneration || 0) + 1;
  const old = request._streamFilter;
  request._streamFilter = null;
  request.filterAttached = false;
  if (old) {
    try { old.disconnect(); } catch {}
  }
}

function attachResponseFilter(requestId) {
  const request = requests.get(requestId);
  if (!request || !FEATURES.bodyCapture) return;
  if (request.filterAttached) return;
  request.filterAttached = true;
  request.filterGeneration = (request.filterGeneration || 0) + 1;
  const gen = request.filterGeneration;
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

  // 兜底 timer:finish() 正常结束后必须清掉,否则每个请求都会遗留一个
  // 存活 10 分钟的 timer(录制上万请求即上万并发空转 timer)。
  // 初值为 0,finish 在 Promise 执行器里同步触发时 clearTimeout(0) 无害。
  let fallbackTimer = 0;
  let captureSettled = false;

  const captureDone = new Promise(resolve => {
    let resolved = false;
    const stillCurrent = () => gen === request.filterGeneration;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      captureSettled = true;
      clearTimeout(fallbackTimer);
      try {
        if (stillCurrent()) finalizeResponseBody(request, chunks, totalBytes);
      } finally {
        pendingBodyCaptures.delete(captureDone);
        resolve();
      }
    };

    request._streamFilter = filter;

    filter.ondata = event => {
      if (!stillCurrent()) return;
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
      if (stillCurrent()) request.responseBodyError = filter.error || "Stream filter error";
      try {
        filter.disconnect();
      } catch {
        // Ignore disconnect errors; the browser owns the response stream.
      }
      finish();
    };
  });

  request.bodyCapturePromise = captureDone;
  // onstop 若在 Promise 执行器里同步触发,finish 已跑完,不要再入 pending,
  // 否则已 resolve 的 promise 会在集合里挂到 10 分钟兜底才删。
  if (captureSettled) return;

  pendingBodyCaptures.add(captureDone);

  // 兜底:极端情况(如发起请求的标签页被立即关闭)下 onstop/onerror 可能都不
  // 触发,此时从 pending 集合移除标记,避免 waitForPendingBodies 无限等待。
  // 不调用 finish():onstop 未触发说明响应数据不完整,宁可不 finalize。
  fallbackTimer = setTimeout(() => { pendingBodyCaptures.delete(captureDone); }, 10 * 60 * 1000);
  if (captureSettled) {
    clearTimeout(fallbackTimer);
    pendingBodyCaptures.delete(captureDone);
  }
}

async function waitForPendingBodies(timeoutMs = 10000) {
  if (!pendingBodyCaptures.size) return;

  const snapshot = [...pendingBodyCaptures];
  let timeoutId = 0;
  const timedOut = await Promise.race([
    Promise.allSettled(snapshot).then(() => false),
    new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(true), timeoutMs);
    })
  ]);
  clearTimeout(timeoutId);
  // 超时后把这一批移出集合,避免 Stop 之后每次导出再白等 10s。
  // 稍后 finish() 仍会写回 request 对象,下一次导出能拿到迟到的 body。
  if (timedOut) {
    for (const p of snapshot) pendingBodyCaptures.delete(p);
  }
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
    startedDateTime: isoString(r.hopStartTime || r.startTime),
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
    // dns/connect/blocked/ssl 拿不到时 HAR 1.2 要求填 -1,不能省略
    timings: { blocked: -1, dns: -1, connect: -1, send, wait, receive, ssl: -1 },
    // --- 逆向上下文扩展字段(下划线前缀,HAR 消费者会忽略未知字段) ---
    _tabId:       r.tabId ?? -1,
    _frameId:     r.frameId ?? -1,
    _parentFrameId: r.parentFrameId ?? -1,
    _originUrl:   r.originUrl || null,
    _documentUrl: r.documentUrl || null,
    _incognito:   !!r.incognito,
    _thirdParty:  !!r.thirdParty,
    _ip:          r.ip || null,
    _fromCache:   !!r.fromCache,
    _proxyInfo:   r.proxyInfo || null,
    _captureSource: r.captureSource || "webRequest"
  };

  if (Array.isArray(r.frameAncestors) && r.frameAncestors.length) {
    entry._frameAncestors = r.frameAncestors.map(f => ({
      url: f.url || "",
      frameId: f.frameId ?? -1
    }));
  }
  if (r.callStack && r.callStack.length) entry._callStack = r.callStack;
  if (r.initiatorType) entry._initiatorType = r.initiatorType;
  if (typeof r.redirectIndex === "number") {
    entry._redirectIndex = r.redirectIndex;
    entry._redirectTotal = r.redirectTotal;
    entry._redirectId = String(r.requestId);
    entry._redirectChain = r.redirectChain || [];
  }
  if (r.transitionType) entry._transitionType = r.transitionType;

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

function redirectChainSummary(r) {
  const hops = r.redirectHops || [];
  const chain = hops.map(h => ({
    url: h.url,
    method: h.method,
    status: h.status,
    redirectURL: h.redirectUrl || ""
  }));
  chain.push({
    url: r.url,
    method: r.method,
    status: r.status || 0,
    redirectURL: ""
  });
  return chain;
}

function buildRedirectEntries(r) {
  const hops = r.redirectHops || [];
  if (!hops.length) return [buildEntry(r)];
  const total = hops.length + 1;
  const chain = redirectChainSummary(r);
  const out = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const keepBody = i === 0 && methodKeepsBody(hop.method);
    out.push(buildEntry(Object.assign({}, r, {
      url: hop.url,
      method: hop.method,
      startTime: hop.startTime,
      hopStartTime: hop.startTime,
      status: hop.status,
      statusLine: hop.statusLine,
      statusText: hop.statusText,
      requestHeaders: hop.requestHeaders,
      responseHeaders: hop.responseHeaders,
      redirectUrl: hop.redirectUrl,
      sendTime: hop.sendTime ?? 0,
      waitTime: hop.waitTime ?? 0,
      receiveTime: hop.receiveTime ?? 0,
      ip: hop.ip || null,
      fromCache: !!hop.fromCache,
      requestPostData: keepBody ? r.requestPostData : null,
      requestPostDataEncoding: keepBody ? r.requestPostDataEncoding : null,
      requestPostDataParams: keepBody ? r.requestPostDataParams : null,
      requestBodySize: keepBody ? r.requestBodySize : 0,
      requestBodyError: keepBody ? r.requestBodyError : null,
      requestBodyRawChunks: null,
      responseBody: undefined,
      responseBodySize: 0,
      responseBodySkipped: false,
      responseBodyTruncated: false,
      responseBodyError: null,
      error: null,
      redirectIndex: i,
      redirectTotal: total,
      redirectChain: chain
    })));
  }
  const finalKeepBody = methodKeepsBody(r.method);
  out.push(buildEntry(Object.assign({}, r, {
    requestBodyRawChunks: null,
    requestPostData: finalKeepBody ? r.requestPostData : null,
    requestPostDataEncoding: finalKeepBody ? r.requestPostDataEncoding : null,
    requestPostDataParams: finalKeepBody ? r.requestPostDataParams : null,
    requestBodySize: finalKeepBody ? r.requestBodySize : 0,
    requestBodyError: finalKeepBody ? r.requestBodyError : null,
    redirectUrl: "",
    redirectIndex: hops.length,
    redirectTotal: total,
    redirectChain: chain
  })));
  return out;
}

function buildEntriesForRequest(r) {
  finalizeRequestBody(r);
  if (r.redirectHops && r.redirectHops.length) return buildRedirectEntries(r);
  return [buildEntry(r)];
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
    const produced = buildEntriesForRequest(r);
    for (const entry of produced) entries.push(entry);
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
    creator: { name: "Network Logger", version: "1.2.11" },
    entries
  };
  // HAR 1.2 允许省略 pages。空数组没有信息量,省略即可。
  // downloadHARStream 序列化的是去掉 entries 后的 meta,空 pages:[] 本身
  // 不会把 JSON 切坏(slice 掉的是对象的 '}'),省略只是为了文件更干净。
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

const SENSITIVE_URL_HEADERS = new Set([
  "referer", "referrer", "location", "content-location", "refresh"
]);

const SENSITIVE_BODY_PATTERNS = [
  /["']?[Bb]earer\s+[A-Za-z0-9_\-.~+\/]+=*["']?/g,
  /("(?:password|passwd|secret|id[_-]?token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token|session[_-]?id|csrf[_-]?token|xsrf[_-]?token|token)")\s*:\s*"[^"]*"/gi,
  /(?:password|passwd|secret|id_token|api_key|access_token|refresh_token|client_secret|token)=[^&\s]*/gi
];

const SENSITIVE_QUERY_PARAMS = new Set([
  "token", "access_token", "refresh_token", "id_token", "api_key", "apikey",
  "key", "secret", "password", "passwd", "session_id", "csrf_token", "auth",
  "client_secret"
]);

function scrubHeaders(headers) {
  if (!headers || !Array.isArray(headers)) return headers;
  return headers.map(h => {
    const name = String(h.name || "").toLowerCase();
    if (SENSITIVE_HEADERS.has(name)) return { name: h.name, value: REDACTED };
    if (SENSITIVE_URL_HEADERS.has(name) && h.value) {
      return { name: h.name, value: scrubUrl(String(h.value)) };
    }
    return h;
  });
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

function scrubAmpSeparatedParams(raw) {
  let changed = false;
  const text = raw.split("&").map(pair => {
    if (!pair) return pair;
    const eq = pair.indexOf("=");
    const rawName = eq > -1 ? pair.slice(0, eq) : pair;
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch { /* 保留原始 name */ }
    if (SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) {
      changed = true;
      return `${rawName}=${REDACTED_URL_VALUE}`;
    }
    return pair;
  }).join("&");
  return { text, changed };
}

function scrubUrl(url) {
  if (!url) return url;
  try {
    const qIdx = url.search(/[?#]/);
    const prefix = qIdx === -1 ? url : url.slice(0, qIdx);
    const rest = qIdx === -1 ? "" : url.slice(qIdx);
    const fragIdx = rest.indexOf("#");
    const queryStr = fragIdx > -1 ? rest.slice(0, fragIdx) : rest; // 含 '?'
    let fragment = fragIdx > -1 ? rest.slice(fragIdx) : "";
    let changed = false;

    // 1) query 敏感参数脱敏。只替换参数值,保留 URL 其余部分的原始字符串
    //    形式,不会把非敏感部分的字符表示规范化改写。
    let scrubbedQuery = "";
    if (queryStr) {
      const result = scrubAmpSeparatedParams(queryStr.slice(1));
      scrubbedQuery = result.text;
      if (result.changed) changed = true;
    }

    // 2) fragment: OAuth implicit 的 #access_token=... 以及 hash 路由
    //    #/path?token=... 都按同样规则擦参数,不能原样拼回去。
    if (fragment.length > 1) {
      const body = fragment.slice(1);
      const fq = body.indexOf("?");
      if (fq > -1) {
        const result = scrubAmpSeparatedParams(body.slice(fq + 1));
        if (result.changed) {
          fragment = `#${body.slice(0, fq)}?${result.text}`;
          changed = true;
        }
      } else if (body.includes("=")) {
        const result = scrubAmpSeparatedParams(body);
        if (result.changed) {
          fragment = `#${result.text}`;
          changed = true;
        }
      }
    }

    // 3) userinfo 脱敏:scheme:// 之后、authority 结束(第一个 '/')之前的
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
      SENSITIVE_QUERY_PARAMS.has(String(q.name || "").toLowerCase())
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
  if (Array.isArray(entry._redirectChain)) {
    entry._redirectChain = entry._redirectChain.map(h => ({
      ...h,
      url: scrubUrl(h.url),
      redirectURL: h.redirectURL ? scrubUrl(h.redirectURL) : h.redirectURL
    }));
  }
  if (Array.isArray(entry._frameAncestors)) {
    entry._frameAncestors = entry._frameAncestors.map(f => ({
      ...f,
      url: scrubUrl(f.url)
    }));
  }
  if (Array.isArray(entry._callStack)) {
    entry._callStack = entry._callStack.map(f => ({
      ...f,
      url: f.url ? scrubUrl(f.url) : f.url
    }));
  }
  return entry;
}

// --- Firefox webRequest event handlers --------------------------------------
function continueRedirectRequest(existing, details) {
  // Firefox re-fires onBeforeRequest after onBeforeRedirect with the same
  // requestId. Keep hops, body, call stack; only refresh fields for the new hop.
  existing.url = details.url;
  existing.method = details.method || existing.method;
  existing.type = details.type || existing.type;
  existing.resourceType = details.type || existing.resourceType;
  if (details.originUrl) existing.originUrl = details.originUrl;
  if (details.documentUrl) existing.documentUrl = details.documentUrl;
  if (details.frameAncestors) existing.frameAncestors = details.frameAncestors;
  if (typeof details.frameId === "number") existing.frameId = details.frameId;
  if (typeof details.parentFrameId === "number") existing.parentFrameId = details.parentFrameId;
  existing.thirdParty = !!details.thirdParty;
  existing.incognito = !!details.incognito;
  if (details.proxyInfo) existing.proxyInfo = details.proxyInfo;

  // HTTP 302: the first StreamFilter usually survives and captures the final
  // body — do not attach a second consumer. HSTS / internal upgrades kill the
  // first channel (`Invalid request ID`); reattach on this continuation.
  if (shouldReattachFilter(existing)) {
    releaseStreamFilter(existing);
    if (isDeadFilterError(existing.responseBodyError) ||
        !(existing._countedResponseBytes > 0)) {
      existing.responseBodyError = null;
      existing.responseBody = undefined;
      existing.responseBodySize = 0;
    }
    attachResponseFilter(details.requestId);
  }
}

function onBeforeRequest(details) {
  if (!isRecording) return {};
  if (isSelfUrl(details.url)) return {};

  const existing = requests.get(details.requestId);
  if (existing) {
    continueRedirectRequest(existing, details);
    return {};
  }

  ensureCapacity();

  const initiator = takeInitiator(details.tabId, details.url, details.method, details.frameId);
  const body = extractRequestBody(details.requestBody);
  const rec = {
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
    originUrl:          details.originUrl || null,
    documentUrl:        details.documentUrl || null,
    resourceType:       details.type || null,
    frameId:            details.frameId ?? -1,
    parentFrameId:      details.parentFrameId ?? -1,
    frameAncestors:     details.frameAncestors || null,
    callStack:          initiator ? initiator.frames : null,
    initiatorType:      initiator ? initiator.via : null,
    captureSource:      "webRequest",
    redirectHops:       [],
    hopStartTime:       details.timeStamp,
    incognito:          !!details.incognito,
    thirdParty:         !!details.thirdParty,
    proxyInfo:          details.proxyInfo || null,
    fromCache:          false,
    ip:                 null,
    filterAttached:     false,
    filterGeneration:   0,
    _countedRequestBytes: body.size || 0,
    _countedResponseBytes: 0
  };
  requests.set(details.requestId, rec);
  liveEntries += 1;
  totalBodyBytes += rec._countedRequestBytes;
  attachResponseFilter(details.requestId);
  updateBadge();
  return {};
}

function onBeforeSendHeaders(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.requestHeaders = details.requestHeaders || [];
  r.method = details.method || r.method;
  // HAR 的 timings.send 定义为"发送请求"耗时:从发起请求到头部发出的时间。
  r.sendTime = Math.max(0, details.timeStamp - hopOrigin(r));
  // requestBody 捕获受限时(如 body 过大或未解析),用 content-length 兜底
  // bodySize,否则导出的 request.bodySize 会恒为 0。
  if (!r.requestBodySize) {
    const cl = getHeaderValue(details.requestHeaders, "content-length");
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n >= 0) r.requestBodySize = n;
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
  // waitTime 定义为"发送完成到收到响应头"的等待时长,减去 sendTime 避免
  // 与 send 阶段重叠,使 HAR timings 三段(send/wait/receive)之和恰好等于
  // 请求总耗时。sendTime 恒在 onHeadersReceived 之前由 onBeforeSendHeaders
  // 写入,即使该事件缺失(值为 0)此式也退化为原来的全量等待时长。
  r.waitTime = Math.max(0, details.timeStamp - hopOrigin(r) - r.sendTime);
  // 对未捕获响应体(NON_BODY_TYPES)的请求,用 content-length 兜底记录大小;
  // 已捕获的请求会在 finalizeResponseBody 里用真实字节数覆盖此值。
  if (!r.responseBodySize) {
    const cl = getHeaderValue(details.responseHeaders, "content-length");
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n >= 0) r.responseBodySize = n;
  }
}

function onBeforeRedirect(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  const origin = hopOrigin(r);
  const receiveTime = Math.max(0, details.timeStamp - origin - r.sendTime - r.waitTime);
  if (!r.redirectHops) r.redirectHops = [];
  r.redirectHops.push({
    url: details.url,
    method: r.method,
    status: details.statusCode || r.status,
    statusLine: details.statusLine || r.statusLine,
    statusText: statusTextFromLine(details.statusLine, details.statusCode) || r.statusText,
    redirectUrl: details.redirectUrl || "",
    requestHeaders: cloneHeaders(r.requestHeaders),
    responseHeaders: cloneHeaders(details.responseHeaders),
    sendTime: r.sendTime,
    waitTime: r.waitTime,
    receiveTime,
    startTime: origin,
    timeStamp: details.timeStamp,
    ip: details.ip || r.ip,
    fromCache: !!details.fromCache
  });
  liveEntries += 1;
  ensureCapacity(details.requestId);
  r.url = details.redirectUrl || r.url;
  r.redirectUrl = details.redirectUrl || "";
  r.status = details.statusCode || r.status;
  r.statusLine = details.statusLine || r.statusLine;
  r.statusText = statusTextFromLine(details.statusLine, details.statusCode);
  r.responseHeaders = details.responseHeaders || r.responseHeaders;
  r.hopStartTime = details.timeStamp;
  r.sendTime = 0;
  r.waitTime = 0;
  r.receiveTime = 0;
}

function onCompleted(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.status = details.statusCode || r.status;
  r.statusLine = details.statusLine || r.statusLine;
  r.statusText = statusTextFromLine(details.statusLine, details.statusCode);
  r.receiveTime = Math.max(0, details.timeStamp - hopOrigin(r) - r.sendTime - r.waitTime);
  // 连接信息:服务器 IP 与是否命中缓存(判断"这请求是否真的走了网络")
  r.ip = details.ip || r.ip;
  r.fromCache = !!details.fromCache;
}

function onErrorOccurred(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.error = details.error || "Request failed";
  r.receiveTime = Math.max(0, details.timeStamp - hopOrigin(r) - r.sendTime - r.waitTime);
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

function mergeRestrictedNav(existing, details, extra) {
  if (extra.error) {
    existing.error = extra.error;
    existing.initiatorType = "navigation-error";
    existing.responseBodyError = extra.error;
  }
  if (details.transitionType) existing.transitionType = details.transitionType;
}

function recordRestrictedNav(details, extra) {
  if (!isRecording || !FEATURES.restrictedNav) return;
  if (!isRestrictedUrl(details.url) || isSelfUrl(details.url)) return;
  extra = extra || {};
  const group = `nav:${details.tabId}:${details.frameId}:${details.url}`;
  const lastId = navLatest.get(group);
  const last = lastId ? requests.get(lastId) : null;
  if (last && Math.abs((last.startTime || 0) - (details.timeStamp || 0)) <= 2000) {
    mergeRestrictedNav(last, details, extra);
    return;
  }
  const id = last ? `${group}:${details.timeStamp}` : group;
  navLatest.set(group, id);
  ensureCapacity();
  requests.set(id, {
    tabId: details.tabId,
    requestId: id,
    url: details.url,
    method: "GET",
    type: details.frameId === 0 ? "main_frame" : "sub_frame",
    requestHeaders: [],
    requestPostData: null,
    requestPostDataEncoding: null,
    requestPostDataParams: null,
    requestBodySize: 0,
    requestBodyError: null,
    requestBodyRawChunks: null,
    requestBodyRawTotalBytes: 0,
    startTime: details.timeStamp,
    hopStartTime: details.timeStamp,
    status: extra.status || 0,
    statusText: extra.statusText || "",
    statusLine: "",
    responseHeaders: [],
    responseBodySize: 0,
    responseBody: undefined,
    responseBodyEncoded: false,
    responseBodyError: extra.error || null,
    responseBodyTruncated: false,
    responseBodySkipped: true,
    sendTime: 0,
    waitTime: 0,
    receiveTime: 0,
    protocol: null,
    redirectUrl: "",
    originUrl: details.originUrl || null,
    documentUrl: details.url,
    resourceType: details.frameId === 0 ? "main_frame" : "sub_frame",
    frameId: details.frameId ?? -1,
    parentFrameId: details.parentFrameId ?? -1,
    frameAncestors: null,
    callStack: null,
    initiatorType: extra.error ? "navigation-error" : "navigation",
    captureSource: "webNavigation",
    redirectHops: [],
    incognito: !!details.incognito,
    thirdParty: false,
    proxyInfo: null,
    fromCache: false,
    ip: null,
    error: extra.error || null,
    transitionType: details.transitionType || null
  });
  liveEntries += 1;
  updateBadge();
}

if (api.webNavigation && api.webNavigation.onCommitted) {
  api.webNavigation.onCommitted.addListener(details => {
    recordRestrictedNav(details, {});
  });
}
if (api.webNavigation && api.webNavigation.onErrorOccurred) {
  api.webNavigation.onErrorOccurred.addListener(details => {
    recordRestrictedNav(details, { error: details.error || "Navigation failed" });
  });
}

if (api.tabs && api.tabs.onRemoved) {
  api.tabs.onRemoved.addListener(tabId => {
    initiatorQueues.delete(tabId);
    const prefix = `nav:${tabId}:`;
    for (const key of [...navLatest.keys()]) {
      if (key.startsWith(prefix)) navLatest.delete(key);
    }
  });
}

function broadcastRecording(value) {
  if (!api.tabs || typeof api.tabs.query !== "function" || typeof api.tabs.sendMessage !== "function") return;
  const msg = { action: "nlSetRecording", recording: !!value };
  ignoreResult(api.tabs.query({}).then(tabs => {
    (tabs || []).forEach(tab => {
      if (typeof tab.id !== "number") return;
      const send = frameId => {
        const p = typeof frameId === "number"
          ? api.tabs.sendMessage(tab.id, msg, { frameId })
          : api.tabs.sendMessage(tab.id, msg);
        if (p && typeof p.catch === "function") p.catch(() => {});
      };
      if (api.webNavigation && typeof api.webNavigation.getAllFrames === "function") {
        ignoreResult(api.webNavigation.getAllFrames({ tabId: tab.id }).then(frames => {
          if (!frames || !frames.length) send();
          else frames.forEach(frame => send(frame.frameId));
        }).catch(() => send()));
      } else {
        send();
      }
    });
  }));
}

// --- Download ----------------------------------------------------------------
// Serialize each entry separately and join as Blob parts so we never
// allocate one contiguous JSON.stringify of the entire HAR. Peak memory is
// still the object graph plus every entry JSON string in `parts` (and the
// Blob) — the win is avoiding a second giant string from stringify(wholeLog),
// and letting the engine keep many smaller ropes instead of one allocation.
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
    if (state === "complete" || state === "interrupted" || state === "canceled") revokeAndDetach();
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
    if (currentState === "complete" || currentState === "interrupted" || currentState === "canceled") {
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
    if (state === "complete" || state === "interrupted" || state === "canceled") revokeAndDetach();
  } catch {
    // If search or addListener throws, the safety timer still detaches.
  }
}

// --- Message handler ---------------------------------------------------------
async function handleMessage(message, sender) {
  if (!sender || sender.id !== api.runtime.id) {
    return { success: false, error: "Unauthorized sender" };
  }
  if (!message || typeof message !== "object") {
    return { success: false, error: "Invalid message" };
  }

  // Content scripts may report call stacks; they must not start/stop/export.
  if (message.action === "initiatorStack") {
    if (!isRecording || !FEATURES.callStack) return { success: true };
    const tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : -1;
    rememberInitiator(tabId, {
      url: String(message.url || ""),
      method: String(message.method || "GET").toUpperCase(),
      frames: parseStack(String(message.stack || "").slice(0, 16384)),
      via: message.via || "script",
      frameId: typeof sender.frameId === "number" ? sender.frameId : 0,
      t: Date.now()
    });
    return { success: true };
  }

  const senderUrl = sender.url || (sender.tab && sender.tab.url) || "";
  const fromExtensionPage = isSelfUrl(senderUrl);

  // Content scripts need a fast in-memory recording flag at document_start.
  // Extension pages (toolbar popup or popup.html opened as a tab) use the
  // full getStatus payload below, including incognitoAllowed.
  if (message.action === "getStatus" && sender.tab && !fromExtensionPage) {
    return { isRecording, count: recordedCount(), startTime: recordingStartTime };
  }

  if (sender.tab && !fromExtensionPage) {
    return { success: false, error: "Unauthorized sender" };
  }

  switch (message.action) {
    case "getStatus":
      return {
        isRecording,
        count: recordedCount(),
        startTime: recordingStartTime,
        incognitoAllowed: await getIncognitoAllowed()
      };

    case "getFeatures":
      return { features: FEATURES };

    case "startRecording":
      if (!isRecording) {
        const startTime = Date.now();
        resetCaptureState();
        // 先打开内存开关,让 getStatus / initiatorStack 立刻生效,再写 storage、
        // 再广播已打开页面去注入 hook,避免 content 先上报却被 !isRecording 丢掉。
        isRecording = true;
        recordingStartTime = startTime;
        updateBadge(true);
        try {
          await api.storage.local.set({ isRecording: true, startTime });
        } catch {
          // 内存已在录;持久化失败时重启不会自动恢复,但本次会话仍可用
        }
        broadcastRecording(true);
      }
      return { success: true, isRecording: true };

    case "stopRecording":
      if (isRecording) {
        isRecording = false;
        broadcastRecording(false);
        await waitForPendingBodies();
        try {
          await api.storage.local.set({ isRecording: false });
        } catch {
          // 内存侧已停止;持久化失败时 popup 仍应看到成功,避免 UI 以为还在录
        }
        updateBadge(true);
      }
      return { success: true, isRecording: false, count: recordedCount() };

    case "clearRecording":
      resetCaptureState();
      isRecording = false;
      recordingStartTime = null;
      broadcastRecording(false);
      try {
        await api.storage.local.set({ isRecording: false });
      } catch {
        // same as stop: in-memory clear already took effect
      }
      updateBadge(true);
      return { success: true };

    case "getCount":
      return { count: recordedCount() };

    case "exportHAR":
      return { success: false, error: "Use downloadHAR" };

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
  if (result && result.isRecording) {
    isRecording = true;
    recordingStartTime = result.startTime || Date.now();
    updateBadge(true);
    broadcastRecording(true);
  } else {
    updateBadge(true);
  }
});
