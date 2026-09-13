"use strict";

/**
 * 采集 → 导出 全链路测试。
 *
 * 覆盖:导出产物是合法 JSON 且条目数守恒、HAR 规范字段齐全、协议版本判定、
 * 响应体文本/base64 决策、以及"响应字节原样写回页面"这个核心不变式。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground, fireRequest, exportHAR, chunk } = require("./helpers/load-background");

// ── 导出完整性 ────────────────────────────────────────────────────────────────

test("导出产物是合法 JSON 且条目数守恒", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  for (let i = 0; i < 5; i++) {
    fireRequest(harness, { requestId: String(i), url: `https://example.com/${i}`, startTime: 1000 + i });
  }
  const { har, download } = await exportHAR(harness);
  assert.equal(har.log.entries.length, 5);
  assert.match(download.filename, /\.har$/);
});

test("空抓包也能导出合法 JSON(entries 为空数组、无 pages 字段)", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  const { raw, har } = await exportHAR(harness);
  assert.deepEqual(har.log.entries, []);
  assert.ok(!("pages" in har.log), "无请求时不应输出 pages");
  assert.ok(raw.startsWith('{"log":'), "拼接的 JSON 头部必须合法");
});

test("creator.version 取自 manifest 而不是硬编码", async () => {
  const harness = loadBackground({ manifestVersion: "7.7.7" });
  await harness.send({ action: "startRecording" });
  fireRequest(harness, {});
  const { har } = await exportHAR(harness);
  assert.equal(har.log.creator.version, "7.7.7");
  assert.equal(har.log.version, "1.2");
});

test("pages 与 pageref 按标签页正确分组", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  fireRequest(harness, { requestId: "a", tabId: 11, url: "https://a.test/", startTime: 1000 });
  fireRequest(harness, { requestId: "b", tabId: 22, url: "https://b.test/", startTime: 1010 });
  fireRequest(harness, { requestId: "c", tabId: 11, url: "https://a.test/x", startTime: 1020 });

  const { har } = await exportHAR(harness);
  assert.equal(har.log.pages.length, 2);
  assert.equal(har.log.pages[0].id, "page_11", "page 应按首条请求时间排序");
  const byUrl = Object.fromEntries(har.log.entries.map(e => [e.request.url, e.pageref]));
  assert.equal(byUrl["https://a.test/"], "page_11");
  assert.equal(byUrl["https://b.test/"], "page_22");
  assert.equal(byUrl["https://a.test/x"], "page_11");
});

// ── 响应体捕获 ────────────────────────────────────────────────────────────────

test("响应字节原样写回页面流(copy 不影响浏览)", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  const filter = fireRequest(harness, { responseChunks: [chunk("hello "), chunk("world")] });
  assert.equal(filter.writtenBytes, 11, "写回字节数必须等于收到的字节数");
  assert.equal(filter.closed, true, "onstop 后必须 close 滤波器");
});

test("文本响应体以可读文本导出,并记录解压前的 content-encoding", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  fireRequest(harness, {
    responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
    responseChunks: [chunk('{"ok":true,"名字":"测试"}')],
  });
  const { har } = await exportHAR(harness);
  const content = har.log.entries[0].response.content;
  assert.equal(content.text, '{"ok":true,"名字":"测试"}');
  assert.equal(content.encoding, undefined);
});

test("超过文本阈值的响应体退化为 base64", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  // 用非文本 MIME 触发低阈值(1MB):构造 >1MB 的字节
  const big = new Uint8Array(1024 * 1024 + 16);
  big.fill(0xff); // 非法 UTF-8,确保走 base64 分支
  fireRequest(harness, {
    responseHeaders: [{ name: "content-type", value: "application/octet-stream" }],
    responseChunks: [big.buffer],
  });
  const { har } = await exportHAR(harness);
  const content = har.log.entries[0].response.content;
  assert.equal(content.encoding, "base64");
  assert.equal(content.size, big.byteLength);
});

test("文本类 MIME 在 1MB 以上仍然可读(逆向主用途)", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  // 1.5MB 的 minified JS —— 这是逆向最常遇到的目标,不能退化成 base64
  const js = `/*${"x".repeat(1024 * 1024 + 512 * 1024)}*/var a=1;`;
  const bytes = new TextEncoder().encode(js);
  assert.ok(bytes.byteLength > 1024 * 1024, "测试数据必须超过旧的 1MB 阈值");

  fireRequest(harness, {
    responseHeaders: [{ name: "content-type", value: "application/javascript" }],
    responseChunks: [bytes.buffer],
  });
  const { har } = await exportHAR(harness);
  const content = har.log.entries[0].response.content;
  assert.equal(content.encoding, undefined, "文本类型不应被 base64");
  assert.equal(content.text, js);
});

test("image/media 跳过响应体但用 content-length 兜底大小", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  fireRequest(harness, {
    type: "image",
    responseHeaders: [{ name: "content-type", value: "image/png" }],
    wireSize: 4096,
    responseChunks: [chunk("not really png")],
  });
  const { har } = await exportHAR(harness);
  const content = har.log.entries[0].response.content;
  assert.equal(content._bodySkipped, true);
  assert.equal(content.text, undefined);
  assert.equal(content.size, 4096, "content.size 应取自 content-length");
});

test("内容大小与传输大小分开记录(content.size vs bodySize)", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  fireRequest(harness, {
    responseHeaders: [{ name: "content-type", value: "text/plain" }],
    wireSize: 999999,
    responseChunks: [chunk("tiny")],
  });
  const { har } = await exportHAR(harness);
  const response = har.log.entries[0].response;
  assert.equal(response.content.size, 4, "content.size 与 content.text 长度一致");
  assert.equal(response.bodySize, 999999, "bodySize 必须保留 content-length 的真实值");
});

test("超过响应体上限时标记 _bodyTruncated,但仍原样转发给页面", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  const wireSize = 80 * 1024 * 1024;
  const filter = fireRequest(harness, {
    responseHeaders: [{ name: "content-type", value: "application/octet-stream" }],
    wireSize,
  });

  const huge = new Uint8Array(50 * 1024 * 1024 + 1);
  filter.ondata({ data: huge.buffer });
  filter.ondata({ data: chunk("after-cap") });
  filter.onstop();

  const { har } = await exportHAR(harness);
  const response = har.log.entries[0].response;
  assert.equal(response.content._bodyTruncated, true);
  assert.equal(response.content.size, 0, "超限后不再累积任何字节");
  assert.equal(response.bodySize, wireSize, "真实传输大小仍然保留");
  assert.equal(filter.writtenBytes, huge.byteLength + 9, "截断只影响 HAR 拷贝,不影响转发");
});

// ── HAR 规范字段 ──────────────────────────────────────────────────────────────

test("timings 带齐 HAR 1.2 要求的字段且三段求和等于总耗时", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  fireRequest(harness, { startTime: 1000 });
  const { har } = await exportHAR(harness);
  const entry = har.log.entries[0];
  for (const key of ["blocked", "dns", "connect", "ssl"]) {
    assert.equal(entry.timings[key], -1, `${key} 不适用时应填 -1`);
  }
  const sum = entry.timings.send + entry.timings.wait + entry.timings.receive;
  assert.equal(sum, entry.time, "timings 三段之和必须等于 time");
  assert.equal(entry.time, 25, "onCompleted 与 startTime 相差 25ms");
});

test("content.compression 反映压缩省下的字节数", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  const body = "x".repeat(1000);
  fireRequest(harness, {
    responseHeaders: [
      { name: "content-type", value: "text/plain" },
      { name: "content-encoding", value: "gzip" },
    ],
    responseChunks: [chunk(body)],
    wireSize: 120,
  });
  const { har } = await exportHAR(harness);
  const response = har.log.entries[0].response;
  assert.equal(response.content.size, 1000);
  assert.equal(response.bodySize, 120, "bodySize 是传输大小");
  assert.equal(response.content.compression, 880);
  assert.equal(response.content._decodedFrom, "gzip");
});

test("httpVersion 来自 details.protocol(h2/h3 不再依赖 statusLine)", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  // 故意把 statusLine 设成 HTTP/1.1:只有 protocol 才是可信来源
  fireRequest(harness, { requestId: "h2", url: "https://a.test/", protocol: "HTTP/2", statusLine: "HTTP/1.1 200" });
  fireRequest(harness, { requestId: "h3", url: "https://b.test/", protocol: "HTTP/3", statusLine: "HTTP/1.1 200", startTime: 2000 });
  const { har } = await exportHAR(harness);
  const byUrl = Object.fromEntries(har.log.entries.map(e => [e.request.url, e.request.httpVersion]));
  assert.equal(byUrl["https://a.test/"], "h2");
  assert.equal(byUrl["https://b.test/"], "h3");
});

test("失败请求保留在 HAR 中并带 response._error", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  harness.sandbox.onBeforeRequest({
    requestId: "err", url: "https://unreachable.test/", method: "GET",
    type: "xmlhttprequest", tabId: 1, frameId: 0, timeStamp: 1000,
  });
  // 必须显式结束滤波器:否则 pendingBodyCaptures 里的捕获永远悬着,导出会
  // 白等 waitForPendingBodies 的 10s 超时,兜底 timer 还会拖住整个进程
  harness.state.filters.at(-1).onstop();
  harness.sandbox.onErrorOccurred({
    requestId: "err", timeStamp: 1030, error: "NS_ERROR_UNKNOWN_HOST", ip: "1.2.3.4",
  });
  const { har } = await exportHAR(harness);
  assert.equal(har.log.entries.length, 1);
  assert.equal(har.log.entries[0].response.status, 0);
  assert.equal(har.log.entries[0].response._error, "NS_ERROR_UNKNOWN_HOST");
  assert.equal(har.log.entries[0]._ip, "1.2.3.4");
});

// ── 状态与上限 ────────────────────────────────────────────────────────────────

test("条目超上限时淘汰最早的请求并在导出中留痕", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  const CAP = 50000;
  for (let i = 0; i <= CAP; i++) {
    fireRequest(harness, { requestId: `r${i}`, url: `https://example.com/${i}`, startTime: 1000 + i });
  }
  // 释放 5 万个未完成的捕获,否则 waitForPendingBodies 会等满 10s 超时
  for (const filter of harness.state.filters) filter.onstop();

  const stopped = await harness.send({ action: "stopRecording" });
  assert.equal(stopped.dropped, 1, "正好淘汰 1 条");
  assert.equal(stopped.count, CAP);

  const status = await harness.send({ action: "getStatus" });
  assert.equal(status.dropped, 1);

  const { raw } = await exportHAR(harness);
  assert.ok(raw.includes('"_droppedEntries":1'), "导出必须标注被淘汰的条目数");
});

test("重新开始录制会清零淘汰计数", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  for (let i = 0; i <= 50000; i++) {
    fireRequest(harness, { requestId: `r${i}`, url: `https://example.com/${i}`, startTime: 1000 + i });
  }
  for (const filter of harness.state.filters) filter.onstop();
  assert.equal((await harness.send({ action: "getStatus" })).dropped, 1);

  await harness.send({ action: "clearRecording" });
  const status = await harness.send({ action: "getStatus" });
  assert.equal(status.dropped, 0);
  assert.equal(status.count, 0);
});

test("未受信任的发送方无法调用消息接口", async () => {
  const harness = loadBackground();
  const result = await harness.sendFromUntrusted({ action: "startRecording" });
  assert.equal(result.success, false);
  assert.equal(result.error, "Unauthorized sender");
  const status = await harness.send({ action: "getStatus" });
  assert.equal(status.isRecording, false);
});

test("badge 刷新被节流,但最终计数准确", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });
  for (let i = 0; i < 500; i++) {
    fireRequest(harness, { requestId: `b${i}`, url: `https://example.com/${i}` });
  }
  // 500 个请求若逐个刷新就是 500 次跨进程 setBadgeText;节流后应远小于此
  assert.ok(harness.state.badgeTexts.length <= 5,
    `badge 未被节流:调用了 ${harness.state.badgeTexts.length} 次`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(harness.state.badgeTexts.at(-1), "500", "节流末尾必须补一次以显示准确计数");
});
test("后台重载后恢复录制会标记 resumed,提示用户数据已丢失", async () => {
  const harness = loadBackground({ initialStorage: { isRecording: true, startTime: 12345 } });
  await new Promise(resolve => setTimeout(resolve, 0)); // 等 storage.get().then 跑完

  const status = await harness.send({ action: "getStatus" });
  assert.equal(status.isRecording, true, "应恢复录制状态");
  assert.equal(status.startTime, 12345);
  assert.equal(status.resumed, true, "必须标记数据已随重启丢失");
  assert.equal(status.count, 0, "重启前抓到的请求不在内存里");

  await harness.send({ action: "clearRecording" });
  assert.equal((await harness.send({ action: "getStatus" })).resumed, false);
});
