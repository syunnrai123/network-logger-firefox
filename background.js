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
// 超过保留上限被淘汰的请求数(见 onBeforeRequest)。导出时写进
// log._droppedEntries —— 一份"看起来完整但少了请求"的 HAR 对逆向最危险。
let droppedEntryCount = 0;
// 后台脚本重载(扩展更新 / 浏览器重启)后从 storage 恢复的录制会话:重启前
// 抓到的数据已随内存丢失,popup 需要据此提示用户而不是显示"REC + 0 请求"。
let resumedFromStorage = false;

// requests map 的条数上限。超限时淘汰最早插入的一条,并把淘汰次数计入
// droppedEntryCount。
const MAX_TRACKED_REQUESTS = 50000;

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

function renderBadge() {
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

// badge 刷新节流:onBeforeRequest 每个请求都会调一次 updateBadge(),录制上万
// 请求就是上万次跨进程 setBadgeText。200ms 窗口内首次立即生效、后续调用合并
// 成一次,窗口末尾再补一次保证最终计数准确 —— 纯 debounce 在持续流量下永远
// 等不到静默期,徽章会长期停在旧值。
const BADGE_THROTTLE_MS = 200;
let badgeTimer = null;
let badgePending = false;

function updateBadge() {
  if (!FEATURES.badge || !actionApi) return;
  if (badgeTimer) { badgePending = true; return; }
  renderBadge();
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    if (badgePending) { badgePending = false; updateBadge(); }
  }, BADGE_THROTTLE_MS);
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

// 严格 UTF-8 解码:字节合法就返回解码结果,否则返回 null。旧实现先
// canDecodeUtf8() 探测(fatal:true)再用 fatal:false 解码一次,对同一份字节
// 做两遍完整遍历并多分配一份中间字符串。严格解码对合法输入与非严格解码
// 逐字符相同,直接复用结果即可省掉这一遍。
function tryDecodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// 解码阈值按 MIME 分级:
// - 明确是文本的类型给 16MB 上限。逆向最常看的压缩后 JS bundle、source map、
//   大 JSON 普遍在 1-5MB,如果统一退化成 base64,导出结果正好在首要用途上
//   不可读 —— 而 isTextContentType 的判断这时完全帮不上忙。
// - 未知类型维持 1MB 低阈值:随机二进制字节可能恰好整体是合法 UTF-8,误判为
//   文本会让二进制不可还原,同时也省去对大字节数组的 UTF-8 探测与解码,降低
//   onstop 阶段的同步阻塞。
// 超过各自上限一律直接 base64,不做任何探测。
const MAX_DECODE_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_DECODE_OTHER_BYTES = 1024 * 1024;

function bytesToHarBody(bytes, headers) {
  const mimeType = getContentType(headers);
  const isText = isTextContentType(mimeType);
  if (bytes.byteLength > (isText ? MAX_DECODE_TEXT_BYTES : MAX_DECODE_OTHER_BYTES)) {
    return { text: bytesToBase64(bytes), encoded: true };
  }

  // 优先按 UTF-8 解码:现代站点普遍输出 UTF-8。仅当字节不是合法 UTF-8
  // (如 GBK/Shift_JIS 编码的中文)时才信任声明的 charset。这样 iso-8859-1 /
  // windows-1252 等单字节编码的声明不会把合法 UTF-8 的中文静默解成乱码 ——
  // 这类编码解码永不出 U+FFFD 替换符,旧的 `includes("�")` 回退条件对它们
  // 完全失效。
  const utf8Text = tryDecodeUtf8(bytes);
  if (utf8Text !== null) return { text: utf8Text, encoded: false };
  if (!isText) return { text: bytesToBase64(bytes), encoded: true };

  try {
    return { text: new TextDecoder(getCharset(headers), { fatal: false }).decode(bytes), encoded: false };
  } catch {
    // 声明的 charset 不被 TextDecoder 识别:用非严格 UTF-8 兜底,保证 HAR 的
    // text 至少是合法字符串,不抛异常(代价是出现 U+FFFD 替换符)。
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), encoded: false };
  }
}

function sanitizeFilename(name) {
  // \x00-\x1f 是 Windows 文件名非法控制字符,逐项删除比替换更安全
  let cleaned = name
    .replace(/\.har$/i, "")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  // Windows 会剥掉文件名末尾的点与空格,必须在保留设备名判断之前去掉:
  // "con." 不满足 /^(con)(\.[^.]+)?$/("." 后面没有字符),原顺序下它会躲过
  // 前缀保护、随后被剥成 "con",加上 .har 就成了 Windows 保留设备名
  // CON.har,downloads.download 直接报错导致导出失败。同理 "con.txt." →
  // "con.txt" → "con.txt.har" 也不合法。
  cleaned = cleaned.replace(/[. ]+$/, "");
  if (!cleaned) cleaned = "network-log";
  // Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9),带任意扩展名也不合法
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]+)?$/i.test(cleaned)) cleaned = "_" + cleaned;
  // 文件名组件上限 ~255 字符(含 .har 扩展名),截断避免超长自定义名导致
  // downloads.download 直接报错而导出失败
  cleaned = cleaned.slice(0, 128);
  // 截断可能重新制造出末尾点/空格(第 128 位正好是 '.'),再剥一次
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

    if (fileParts.length) {
      // part.file 表示该段的文件内容没有出现在 raw 里(Firefox 不暴露上传文件
      // 字节),multipart 流中会留下一段空洞。即使同时存在内联字段也要标注,
      // 否则 HAR 看起来像一份完整的请求体。
      const note = `File part content not captured: ${fileParts.join(", ")}`;
      result.error = result.error ? `${result.error}; ${note}` : note;
    }

    if (chunks.length) {
      result.rawChunks = chunks;
      result.rawTotalBytes = totalBytes;
      result.size = totalBytes;
    } else if (fileParts.length) {
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
  let timeoutTimer;
  const timeout = new Promise(resolve => { timeoutTimer = setTimeout(resolve, timeoutMs); });
  // 正常路径下 pending 先 settle,超时定时器无人回收,每次调用都会留下一个
  // 仍在计时的句柄;用 finally 保证两条分支都清掉。
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timeoutTimer));
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

  // content.size 是解压后的内容大小,response.bodySize 按 HAR 规范是实际传输
  // 大小 —— content-length 在 wire 上恰好就是压缩后大小,直接用它。缺失(分块
  // 传输)时退化为内容大小,compression 记 0。被截断的响应据此保留真实传输
  // 大小,不再被部分字节数覆盖掉。
  const contentSize = r.responseBodySize ?? 0;
  const wireSize = r.wireSize > 0 ? r.wireSize : contentSize;

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
        size:     contentSize,
        // HAR 规范:compression = content.size - bodySize,即压缩省下的字节数
        compression: contentSize > wireSize ? contentSize - wireSize : 0,
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
      bodySize:    wireSize
    },
    cache:   {},
    // HAR 1.2 要求 timings 带上这些字段,不适用时填 -1。webRequest 不提供
    // DNS / TCP / SSL 分段耗时,这里如实标注为不可用,而不是省略字段让按规范
    // 做校验的消费者解析失败。
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send, wait, receive },
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
    // 版本号的唯一来源是 manifest.json,不再各处硬编码后漂移
    creator: { name: "Network Logger", version: api.runtime.getManifest().version },
    entries
  };
  // 注意:downloadHARStream 用 JSON.stringify(log).slice(0,-1) 拼接 entries,
  // 空数组 `"pages":[]` 会被切成 `"pages":[` 导致非法 JSON,因此只有存在
  // page 时才输出 pages 字段。
  if (pages.length) log.pages = pages;
  // 超过保留条数上限被淘汰的请求数。响应体截断有 _bodyTruncated 标注,条目
  // 淘汰同样必须留痕 —— 一份"看起来完整但少了请求"的 HAR 对逆向最危险。
  if (droppedEntryCount > 0) log._droppedEntries = droppedEntryCount;
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

// 每条规则自带替换器,不再靠匹配文本里的 ':' / '=' 猜分隔符。原因:Bearer
// token 自身的 base64 padding 就是 '=',按"第一个 ="切分会把整个 token 原样
// 留在 HAR 里(实测 "Authorization: Bearer YWJjZGVmZ2hpamtsbW5vcA==" 会变成
// "Authorization: Bearer YWJjZGVmZ2hpamtsbW5vcA=[REDACTED]")—— 这正是用户
// 开启脱敏后最不能出现的结果。
const SENSITIVE_BODY_RULES = [
  {
    // Bearer 凭据:整段(含 "Bearer" 前缀)替换
    pattern: /["']?[Bb]earer\s+[A-Za-z0-9_\-.~+\/]+=*["']?/g,
    replace: () => REDACTED
  },
  {
    // JSON 字段:保留键名,只替换值
    pattern: /("(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token|session[_-]?id|csrf[_-]?token|xsrf[_-]?token)")\s*:\s*"[^"]*"/gi,
    replace: match => match.substring(0, match.indexOf(":") + 1) + ` "${REDACTED}"`
  },
  {
    // URL-encoded / 表单字段:保留键名。键名候选里不含 '=',第一个 '=' 必然是分隔符
    pattern: /(?:password|passwd|secret|token|api_key|access_token|refresh_token|client_secret)=[^&\s]*/gi,
    replace: match => match.substring(0, match.indexOf("=") + 1) + REDACTED
  }
];

function scrubBodyText(text) {
  if (!text || typeof text !== "string") return text;
  let scrubbed = scrubJwtLike(text);
  for (const rule of SENSITIVE_BODY_RULES) {
    rule.pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(rule.pattern, rule.replace);
  }
  return scrubbed;
}

const SENSITIVE_QUERY_PARAMS = new Set([
  "token", "access_token", "refresh_token", "api_key", "apikey",
  "key", "secret", "password", "passwd", "session_id", "csrf_token", "auth"
]);

// 值本身是 URL 的头部:它们的 query/fragment 里可能带着凭据。典型场景是
// 魔法链接或 OAuth 回调 —— 落地页 URL 里带 token,之后该页发出的每个请求
// 都会在 Referer 里重复这个 token;重定向响应则把 token 放在 Location。
// scrubEntry 已经对 _originUrl / _documentUrl 做了同样的处理,这里补上头部。
const URL_BEARING_HEADERS = new Set([
  "referer", "referrer", "location", "content-location", "origin"
]);

function scrubHeaders(headers) {
  if (!headers || !Array.isArray(headers)) return headers;
  return headers.map(h => {
    const name = String(h.name || "").toLowerCase();
    if (SENSITIVE_HEADERS.has(name)) return { name: h.name, value: REDACTED };
    if (URL_BEARING_HEADERS.has(name)) {
      return { name: h.name, value: scrubUrl(String(h.value ?? "")) };
    }
    return h;
  });
}

function scrubCookies(cookies) {
  if (!cookies || !Array.isArray(cookies)) return cookies;
  return cookies.map(c => ({ ...c, value: REDACTED }));
}

// JWT 三段 base64url(不限定 eyJ 前缀,兼容非标准 header 的 token)。
//
// 不能用 /(^|[^A-Za-z0-9_-])(seg)\.(seg)\.(seg)(...)/ 形式的正则:当第三段
// 不存在时,第二段上的 {10,} 要逐字符回溯去找后面的 '.',回溯深度随该段长度
// 增长并撑爆 regexp 回溯栈 —— 实测"4MB token 串 + '.' + 4MB token 串"直接抛
// RangeError: Maximum call stack size exceeded,而 scrubEntry 里的异常会让整次
// 导出失败(不是只丢一个 body)。解码阈值放宽到 16MB 之后这种巨型文本更容易
// 进入脱敏路径,所以改为手工扫描。
//
// 扫描保持正则的语义:只在每段 token 串的起点尝试,失败就跳到该段末尾,因此
// 整体线性、无回溯,任意长度都不会溢出。
const MIN_JWT_SEGMENT = 10;
const CHAR_DOT = 46; // '.'

// base64url 字符集:A-Z a-z 0-9 _ -(RFC 4648 §5)
function isTokenChar(code) {
  return (code >= 48 && code <= 57)      // 0-9
      || (code >= 65 && code <= 90)      // A-Z
      || (code >= 97 && code <= 122)     // a-z
      || code === 95 || code === 45;     // _ -
}

function scrubJwtLike(text) {
  if (!text || text.indexOf(".") < 0) return text;

  const pieces = [];
  let cursor = 0; // 已确认无需改写的部分末尾
  let i = 0;
  const len = text.length;

  while (i < len) {
    const seg1Start = i;
    while (i < len && isTokenChar(text.charCodeAt(i))) i++;
    // 该位置不是 token 字符(空段):前进一格,保证下一轮 i 仍是某段的起点
    if (i === seg1Start) { i++; continue; }
    if (text.charCodeAt(i) !== CHAR_DOT || i - seg1Start < MIN_JWT_SEGMENT) continue;

    const seg2Start = i + 1;
    let seg2End = seg2Start;
    while (seg2End < len && isTokenChar(text.charCodeAt(seg2End))) seg2End++;
    if (text.charCodeAt(seg2End) !== CHAR_DOT || seg2End - seg2Start < MIN_JWT_SEGMENT) {
      i = seg2End;
      continue;
    }

    const seg3Start = seg2End + 1;
    let seg3End = seg3Start;
    while (seg3End < len && isTokenChar(text.charCodeAt(seg3End))) seg3End++;
    if (seg3End - seg3Start < MIN_JWT_SEGMENT) { i = seg3End; continue; }

    // 三段齐备,且第三段之后必然是非 token 字符或串尾(与正则的尾部边界等价)
    pieces.push(text.slice(cursor, seg1Start), REDACTED);
    cursor = seg3End;
    i = seg3End;
  }

  if (!pieces.length) return text;
  pieces.push(text.slice(cursor));
  return pieces.join("");
}

// 按 query 串规则脱敏敏感参数值(不含前导 '?' 或 '#')。无变化时返回 null,让
// 调用方知道这一段不必重写。
//
// '?' 与 '&' 同等看待为参数分隔符:参数值里完全可能出现 '?'(最典型的是
// `#access_token=..&redirect=https://x/?a=1`)。如果只按 '&' 切分,"?" 之后的
// 内容会被当成同一个值的一部分,参数名解析就此跑偏。分隔符原样保留。
function scrubQueryLike(raw) {
  if (!raw) return null;
  let changed = false;
  const out = raw.split(/([&?])/).map(seg => {
    // 分隔符段与空段(连续分隔符)原样保留,不参与参数名判定
    if (!seg || seg === "&" || seg === "?") return seg;
    const eq = seg.indexOf("=");
    const rawName = eq > -1 ? seg.slice(0, eq) : seg;
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch { /* 保留原始 name */ }
    if (SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) {
      changed = true;
      // 裸参数(无 =)也补上脱敏值,与 queryString 数组解析结果保持一致
      return `${rawName}=${REDACTED_URL_VALUE}`;
    }
    return seg;
  }).join("");
  return changed ? out : null;
}

function scrubUrl(url) {
  if (!url) return url;
  try {
    const qIdx = url.search(/[?#]/);
    const prefix = qIdx === -1 ? url : url.slice(0, qIdx);
    const rest = qIdx === -1 ? "" : url.slice(qIdx);
    const fragIdx = rest.indexOf("#");
    const queryStr = fragIdx > -1 ? rest.slice(0, fragIdx) : rest; // 含 '?'
    const fragment = fragIdx > -1 ? rest.slice(fragIdx) : "";      // 含 '#'
    let changed = false;

    // 1) query 敏感参数脱敏。只替换参数值,保留 URL 其余部分的原始字符串
    //    形式,不会把非敏感部分的字符表示规范化改写。
    let scrubbedQuery = queryStr.slice(1);
    const scrubbedParams = scrubQueryLike(scrubbedQuery);
    if (scrubbedParams !== null) { scrubbedQuery = scrubbedParams; changed = true; }

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

    // 3) fragment 脱敏。fragment 不是安全区:OAuth implicit flow 把最终 token
    //    放在 `#access_token=..&state=..`,hash 路由把 query 放在
    //    `#/path?token=..`,两种都曾被原样写进 HAR。
    //    这里不再区分"hash 路由 / query 串"——`?` 既可能是路由分隔符,也可能
    //    是参数值的一部分(`#access_token=..&redirect=https://x/?a=1`),按第一
    //    个 `?` 切分会让 `?` 之前的敏感参数整段被跳过(实测可泄露 access_token)。
    //    统一交给 scrubQueryLike 处理,它同时把 `&` 和 `?` 当分隔符。
    //    只含 [=&?] 之一时才当作参数串,否则普通锚点(`#section-2`、`#token-usage`)
    //    必须保持原样。
    let scrubbedFragment = fragment;
    if (fragment.length > 1 && /[=&?]/.test(fragment)) {
      const scrubbedHash = scrubQueryLike(fragment.slice(1));
      if (scrubbedHash !== null) { scrubbedFragment = `#${scrubbedHash}`; changed = true; }
    }

    if (!changed) return url;
    return `${scrubbedPrefix}${queryStr ? `?${scrubbedQuery}` : ""}${scrubbedFragment}`;
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
    // formData 解析出的结构化参数数组与 postData.text 是同一份数据
    // (scrubBodyText 已把 text 里的值替换成 [REDACTED]),必须用同一个占位符,
    // 否则同一字段在两个视图里显示不同的脱敏标记。URL 串 / queryString 那一对
    // 继续用 REDACTED_URL_VALUE —— 只有它们会被 URL 编码规范化改写。
    if (Array.isArray(entry.request.postData.params)) {
      entry.request.postData.params = entry.request.postData.params.map(p =>
        SENSITIVE_QUERY_PARAMS.has(String(p.name || "").toLowerCase())
          ? { name: p.name, value: REDACTED }
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

  if (requests.size >= MAX_TRACKED_REQUESTS) {
    const oldestKey = requests.keys().next().value;
    requests.delete(oldestKey);
    droppedEntryCount++;
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
    wireSize:           -1,
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
  // details.protocol 是 "HTTP/1.1" / "HTTP/2" / "HTTP/3" 这类可直接判定的值,
  // 之前这一项从未写回,httpVersion 只能靠 statusLine 字符串猜。
  r.protocol = details.protocol || r.protocol;
  // waitTime 定义为"发送完成到收到响应头"的等待时长,减去 sendTime 避免
  // 与 send 阶段重叠,使 HAR timings 三段(send/wait/receive)之和恰好等于
  // 请求总耗时。sendTime 恒在 onHeadersReceived 之前由 onBeforeSendHeaders
  // 写入,即使该事件缺失(值为 0)此式也退化为原来的全量等待时长。
  r.waitTime = Math.max(0, details.timeStamp - r.startTime - r.sendTime);
  // content-length 是传输大小(压缩后),单独记录:buildEntry 用它填
  // response.bodySize 并算出 content.compression。不再写进 responseBodySize,
  // 否则被截断的响应会连真实大小一起丢掉。
  const contentLength = parseInt(getHeaderValue(details.responseHeaders, "content-length"), 10);
  if (Number.isFinite(contentLength) && contentLength > 0) r.wireSize = contentLength;
  // 对未捕获响应体(NON_BODY_TYPES)的请求,用 content-length 兜底记录大小;
  // 已捕获的请求会在 finalizeResponseBody 里用真实字节数覆盖此值。
  if (!r.responseBodySize && r.wireSize > 0) r.responseBodySize = r.wireSize;
}

function onBeforeRedirect(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.status = details.statusCode || r.status;
  r.statusLine = details.statusLine || r.statusLine;
  r.statusText = statusTextFromLine(details.statusLine, details.statusCode);
  r.responseHeaders = details.responseHeaders || r.responseHeaders;
  r.protocol = details.protocol || r.protocol;
  r.redirectUrl = details.redirectUrl || "";
  r.receiveTime = Math.max(0, details.timeStamp - r.startTime - r.sendTime - r.waitTime);
}

function onCompleted(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.status = details.statusCode || r.status;
  r.statusLine = details.statusLine || r.statusLine;
  r.statusText = statusTextFromLine(details.statusLine, details.statusCode);
  r.protocol = details.protocol || r.protocol;
  r.receiveTime = Math.max(0, details.timeStamp - r.startTime - r.sendTime - r.waitTime);
  // 连接信息:服务器 IP 与是否命中缓存(判断"这请求是否真的走了网络")
  r.ip = details.ip || r.ip;
  r.fromCache = !!details.fromCache;
}

function onErrorOccurred(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.error = details.error || "Request failed";
  r.receiveTime = Math.max(0, details.timeStamp - r.startTime - r.sendTime - r.waitTime);
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
function isTrustedExtensionSender(sender) {
  return sender && sender.id === api.runtime.id && !sender.tab;
}

async function handleMessage(message, sender) {
  if (!isTrustedExtensionSender(sender)) {
    return { success: false, error: "Unauthorized sender" };
  }

  switch (message.action) {
    case "getStatus":
      return {
        isRecording,
        count: requests.size,
        startTime: recordingStartTime,
        dropped: droppedEntryCount,
        resumed: resumedFromStorage
      };

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
        droppedEntryCount = 0;
        resumedFromStorage = false;
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
      return { success: true, isRecording: false, count: requests.size, dropped: droppedEntryCount };

    case "clearRecording":
      requests.clear();
      pendingBodyCaptures.clear();
      isRecording = false;
      recordingStartTime = null;
      droppedEntryCount = 0;
      resumedFromStorage = false;
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
      return {
        success: true,
        count: har.log.entries.length,
        failedCount,
        droppedCount: har.log._droppedEntries || 0
      };
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
// 后台脚本重载(扩展更新 / 浏览器重启)后 requests map 必然为空,而 storage 里的
// isRecording 仍是 true。继续录制是有用的,但不能让 popup 只看到一个
// "REC + 0 请求"的假象:重启前抓到的数据已经不在内存里了。resumedFromStorage
// 随 getStatus 一起返回,由 popup 明确提示。
api.storage.local.get(["isRecording", "startTime"]).then(result => {
  if (result.isRecording) {
    isRecording = true;
    recordingStartTime = result.startTime || Date.now();
    resumedFromStorage = true;
    updateBadge();
  } else if (actionApi) {
    ignoreResult(actionApi.setBadgeText({ text: "" }));
  }
});
