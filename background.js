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

function updateBadge() {
  if (!FEATURES.badge || !actionApi) return;

  if (isRecording) {
    const count = requests.size;
    const text = count > 9999 ? "9999+" : count > 0 ? String(count) : "*";
    ignoreResult(actionApi.setBadgeText({ text }));
    ignoreResult(actionApi.setBadgeBackgroundColor({ color: "#ef4444" }));
  } else if (requests.size > 0) {
    ignoreResult(actionApi.setBadgeText({ text: String(requests.size) }));
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
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function canDecodeUtf8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function bytesToHarBody(bytes, headers) {
  const mimeType = getContentType(headers);
  const shouldDecode = isTextContentType(mimeType) || canDecodeUtf8(bytes);

  if (shouldDecode) {
    try {
      return {
        text: new TextDecoder(getCharset(headers), { fatal: false }).decode(bytes),
        encoded: false
      };
    } catch {
      return {
        text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        encoded: false
      };
    }
  }

  return { text: bytesToBase64(bytes), encoded: true };
}

function sanitizeFilename(name) {
  return name.replace(/\.har$/i, "").replace(/[<>:"/\\|?*]/g, "_");
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

function attachResponseFilter(requestId) {
  const request = requests.get(requestId);
  if (!request || !FEATURES.bodyCapture) return;

  let filter;
  try {
    filter = api.webRequest.filterResponseData(requestId);
  } catch (err) {
    request.responseBodyError = err.message || String(err);
    return;
  }

  const chunks = [];
  let totalBytes = 0;

  const captureDone = new Promise(resolve => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        finalizeResponseBody(request, chunks, totalBytes);
      } finally {
        pendingBodyCaptures.delete(captureDone);
        resolve();
      }
    };

    filter.ondata = event => {
      const view = new Uint8Array(event.data);
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      chunks.push(copy);
      totalBytes += copy.byteLength;
      filter.write(event.data);
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
      cookies:     [],
      headers:     reqHeaders,
      queryString: parseQueryString(r.url),
      headersSize: -1,
      bodySize:    r.requestBodySize ?? 0
    },
    response: {
      status:      r.status || 200,
      statusText:  r.statusText || statusTextFor(r.status),
      httpVersion: httpVer(r.protocol, r.statusLine),
      cookies:     [],
      headers:     respHeaders,
      content: {
        size:     r.responseBodySize ?? 0,
        mimeType: getContentType(r.responseHeaders)
      },
      redirectURL: r.redirectUrl || "",
      headersSize: -1,
      bodySize:    r.responseBodySize ?? 0
    },
    cache:   {},
    timings: { send, wait, receive }
  };

  if (r.requestPostData !== null && r.requestPostData !== undefined) {
    entry.request.postData = {
      mimeType: getContentType(r.requestHeaders) || "application/octet-stream",
      text:     r.requestPostData
    };
    if (r.requestPostDataEncoding) entry.request.postData.encoding = r.requestPostDataEncoding;
    if (r.requestPostDataParams) entry.request.postData.params = r.requestPostDataParams;
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

  return entry;
}

function buildHAR() {
  const entries = [];
  requests.forEach(r => {
    if (!r.status || r.status < 100) return;
    entries.push(buildEntry(r));
  });
  entries.sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));
  return {
    log: {
      version: "1.2",
      creator: { name: "Network Logger", version: "1.2.0" },
      entries
    }
  };
}

async function buildHARAfterBodyFlush() {
  await waitForPendingBodies();
  return buildHAR();
}

// --- Sensitive Data Scrubbing ------------------------------------------------
const REDACTED = "[REDACTED]";

const SENSITIVE_HEADERS = new Set([
  "authorization", "cookie", "set-cookie", "proxy-authorization",
  "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token",
  "x-access-token", "x-session-id", "www-authenticate", "proxy-authenticate"
]);

const SENSITIVE_BODY_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
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

function scrubBodyText(text) {
  if (!text || typeof text !== "string") return text;
  let scrubbed = text;
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
    const parsed = new URL(url);
    let changed = false;
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

function scrubEntry(entry) {
  const e = JSON.parse(JSON.stringify(entry));
  e.request.url = scrubUrl(e.request.url);
  e.request.headers = scrubHeaders(e.request.headers);
  e.request.cookies = scrubCookies(e.request.cookies);
  if (e.request.queryString) {
    e.request.queryString = e.request.queryString.map(q =>
      SENSITIVE_QUERY_PARAMS.has(q.name.toLowerCase())
        ? { name: q.name, value: REDACTED }
        : q
    );
  }
  if (e.request.postData && e.request.postData.text && !e.request.postData.encoding) {
    e.request.postData.text = scrubBodyText(e.request.postData.text);
  }
  e.response.headers = scrubHeaders(e.response.headers);
  e.response.cookies = scrubCookies(e.response.cookies);
  if (e.response.content && e.response.content.text && !e.response.content.encoding) {
    e.response.content.text = scrubBodyText(e.response.content.text);
  }
  return e;
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
    sendTime:           0,
    waitTime:           0,
    receiveTime:        0,
    protocol:           null,
    redirectUrl:        ""
  });

  attachResponseFilter(details.requestId);
  updateBadge();
  return {};
}

function onBeforeSendHeaders(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.requestHeaders = details.requestHeaders || [];
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
}

function onErrorOccurred(details) {
  const r = requests.get(details.requestId);
  if (!r) return;
  r.error = details.error || "Request failed";
  r.receiveTime = Math.max(0, details.timeStamp - r.startTime - r.waitTime);
}

const allUrls = { urls: ["<all_urls>"] };
api.webRequest.onBeforeRequest.addListener(onBeforeRequest, allUrls, ["blocking", "requestBody"]);
api.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, allUrls, ["requestHeaders"]);
api.webRequest.onHeadersReceived.addListener(onHeadersReceived, allUrls, ["responseHeaders"]);
api.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, allUrls, ["responseHeaders"]);
api.webRequest.onCompleted.addListener(onCompleted, allUrls);
api.webRequest.onErrorOccurred.addListener(onErrorOccurred, allUrls);

// --- Download ----------------------------------------------------------------
async function downloadHARFile(json, filename) {
  const blob = new Blob([json], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  try {
    await api.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
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
      isRecording = false;
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
      const json = JSON.stringify(har, null, 2);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const baseName = (FEATURES.customFilename && message.customFilename)
        ? sanitizeFilename(message.customFilename)
        : `network-log-${ts}`;
      const filename = `${baseName}.har`;
      await downloadHARFile(json, filename);
      return { success: true, count: har.log.entries.length };
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
