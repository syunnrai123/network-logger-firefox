"use strict";

/**
 * 脱敏回归测试。
 *
 * 这一组对应两个已修的真实泄露:开启 "Scrub sensitive data" 后 token 仍然明文
 * 出现在 HAR 里。它们是本插件唯一的安全承诺,必须由测试锁死。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground, fireRequest, exportHAR, chunk } = require("./helpers/load-background");

function withBackground(fn) {
  const harness = loadBackground();
  return fn(harness);
}

// ── 请求体文本脱敏 ────────────────────────────────────────────────────────────

test("scrubBodyText 完全移除带 base64 padding 的 Bearer token", () => {
  withBackground(({ sandbox }) => {
    const tokens = [
      "YWJjZGVmZ2hpamtsbW5vcA==",                 // 单层 padding
      "abc123==",                                  // 短 token + padding
      "dGhpcy1pcy1hLXRva2Vu",                      // 无 padding
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",  // 类 JWT
      "aGVsbG8+d29ybGQvYQ==",                      // 含 base64 字符集边界
    ];
    for (const token of tokens) {
      const input = `Authorization: Bearer ${token}`;
      const out = sandbox.scrubBodyText(input);
      assert.ok(!out.includes(token), `token 泄露: ${JSON.stringify(out)}`);
      assert.ok(!out.includes("Bearer"), `Bearer 前缀未清理: ${JSON.stringify(out)}`);
      assert.ok(out.includes("[REDACTED]"), "应留下脱敏标记");
    }
  });
});

test("scrubBodyText 在 JSON 与表单体里保留键名只替换值", () => {
  withBackground(({ sandbox }) => {
    const json = sandbox.scrubBodyText('{"username":"bob","password":"hunter2","token":"abc"}');
    assert.ok(!json.includes("hunter2"));
    assert.ok(!json.includes('"abc"'));
    assert.equal(json, '{"username":"bob","password": "[REDACTED]","token": "[REDACTED]"}');

    const form = sandbox.scrubBodyText("user=bob&password=hunter2&api_key=SECRETKEY");
    assert.ok(!form.includes("hunter2"));
    assert.ok(!form.includes("SECRETKEY"));
    assert.equal(form, "user=bob&password=[REDACTED]&api_key=[REDACTED]");
  });
});

test("scrubBodyText 仍会移除无前缀的裸 JWT", () => {
  withBackground(({ sandbox }) => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = sandbox.scrubBodyText(`token in hand: ${jwt}`);
    assert.ok(!out.includes(jwt), `裸 JWT 泄露: ${out}`);
  });
});

test("scrubJwtLike 与原始正则语义一致(边界保留、段长门槛)", () => {
  withBackground(({ sandbox }) => {
    // 参考实现:迁移前使用的正则。注意第 5 个捕获组(尾部边界字符)是被匹配
    // 消费掉的,替换时必须回填,否则会把 JWT 后面的分隔符一并吃掉。
    const REF = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})([^A-Za-z0-9_-]|$)/g;
    const ref = t => t.replace(REF, (m, lead, _s1, _s2, _s3, trail) => lead + "[REDACTED]" + trail);
    for (const s of [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig==",
      "x abcdefghij.klmnopqrst.uvwxyzABCD y",
      "abcdefghij.klmnopqrst.uvwxyzABCD.",
      "abcdefghij.klmnopqrst.uvwxyzABCD.efghijklmn",
      "abcdefghij.abcdefghij.abcdefghij.abcdefghij",
      "abcdefghi.klmnopqrst.uvwxyzABCD",   // 第一段 9 字符,不足 10
      "abcdefghij.klmnopqrs.uvwxyzABCD",   // 第二段不足
      "abcdefghij.klmnopqrst.uvwxyzABC",   // 第三段不足
      ".abcdefghij.klmnopqrst.uvwxyzABCD",
      "prefix_abcdefghij.klmnopqrst.uvwxyzABCD_suffix",
      "", ".", "..", "...", "no dots",
    ]) {
      assert.equal(sandbox.scrubJwtLike(s), ref(s), `与参考实现不一致: ${JSON.stringify(s)}`);
    }
  });
});

test("scrubJwtLike 在长 token 串上不再爆栈(旧正则的致命缺陷)", () => {
  withBackground(({ sandbox }) => {
    // 旧正则的第二段 {10,} 在找不到第三个 '.' 时会逐字符回溯,4MB 级别即
    // "RangeError: Maximum call stack size exceeded"。scrubEntry 里的异常会
    // 让整次导出失败,所以这是必须锁死的回归点。
    const MB = 1024 * 1024;
    const cases = [
      "A".repeat(4 * MB) + "." + "B".repeat(4 * MB),                 // 无第三段
      "A".repeat(4 * MB) + "." + "B".repeat(4 * MB) + "." + "C",     // 第三段过短
      "A".repeat(8 * MB),                                            // 单段无分隔
      "A".repeat(2 * MB) + "." + "B".repeat(2 * MB) + "." + "C".repeat(2 * MB), // 合法三段
    ];
    for (const input of cases) {
      let out;
      assert.doesNotThrow(() => { out = sandbox.scrubJwtLike(input); }, "长 token 串不应抛异常");
      assert.equal(typeof out, "string");
      assert.ok(out.length > 0);
    }
    // 前两个用例没有合法的三段结构 -> 不应改写;第三个同理
    for (const i of [0, 1, 2]) {
      const input = cases[i];
      assert.equal(sandbox.scrubJwtLike(input), input, "无三段结构时不应误判为 JWT");
    }
    // 合法的三段必须被整体脱敏
    const triple = cases[3];
    assert.ok(!sandbox.scrubJwtLike(triple).includes("B".repeat(200)), "合法 JWT 三段必须脱敏");
  });
});

// ── URL 脱敏 ──────────────────────────────────────────────────────────────────

test("scrubUrl 脱敏 query 敏感参数", () => {
  withBackground(({ sandbox }) => {
    assert.equal(
      sandbox.scrubUrl("https://api.example.com/v1/user?token=SECRET123&id=5"),
      "https://api.example.com/v1/user?token=REDACTED&id=5"
    );
    // 裸参数(无 "=")且名字本身就是敏感名时补上脱敏值,与 queryString 数组一致
    assert.equal(
      sandbox.scrubUrl("https://x.com/p?token&a=1"),
      "https://x.com/p?token=REDACTED&a=1"
    );
    // 只是名字里含 "token" 的普通参数不能被改写
    assert.equal(
      sandbox.scrubUrl("https://x.com/p?bare_token&a=1"),
      "https://x.com/p?bare_token&a=1"
    );
  });
});

test("scrubUrl 脱敏 fragment —— OAuth implicit flow 是重点", () => {
  withBackground(({ sandbox }) => {
    assert.equal(
      sandbox.scrubUrl("https://app.example.com/#access_token=IMPLICITFLOWSECRET&state=x"),
      "https://app.example.com/#access_token=REDACTED&state=x"
    );
    assert.equal(
      sandbox.scrubUrl("https://app.example.com/cb#/route?token=HASHSECRET"),
      "https://app.example.com/cb#/route?token=REDACTED"
    );
    assert.equal(
      sandbox.scrubUrl("https://example.com/path?a=1#token=FRAGTOK"),
      "https://example.com/path?a=1#token=REDACTED"
    );
  });
});

test("scrubUrl 在 fragment 参数值内含 '?' 时仍能脱敏前面的敏感参数", () => {
  withBackground(({ sandbox }) => {
    // 按第一个 '?' 区分"hash 路由"会在这里栽跟头:'?' 落在 redirect 的值里,
    // '?' 之前的 access_token 会被整段跳过 —— 实测可泄露。
    const cases = [
      ["#access_token=SECRET&redirect=https://x.com/?a=1", "redirect 值含 ?"],
      ["#token=SECRET?x=1", "敏感参数在前"],
      ["#access_token=SECRET&next=/p?y=2", "next 值含 /?"],
      ["#state=a&auth=SECRET?b", "敏感参数在后"],
      ["#state=a&next=/p?auth=SECRET", "敏感参数在 ? 之后"],
    ];
    for (const [frag, desc] of cases) {
      const out = sandbox.scrubUrl(`https://app.example.com/cb${frag}`);
      assert.ok(!out.includes("SECRET"), `${desc} 泄露: ${out}`);
      assert.ok(out.includes("REDACTED"), `${desc} 未产生脱敏标记: ${out}`);
    }
  });
});

test("scrubUrl 保留普通锚点与无敏感参数的 fragment", () => {
  withBackground(({ sandbox }) => {
    for (const url of [
      "https://example.com/doc#section-2",
      "https://example.com/doc#/route",
      "https://example.com/doc#token-usage",
      "https://example.com/doc#",
      "https://example.com/plain",
    ]) {
      assert.equal(sandbox.scrubUrl(url), url, `不应改写 ${url}`);
    }
  });
});

test("scrubUrl 脱敏 userinfo 凭据", () => {
  withBackground(({ sandbox }) => {
    assert.equal(
      sandbox.scrubUrl("https://user:p4ssw0rd@api.example.com/path"),
      "https://REDACTED@api.example.com/path"
    );
    assert.equal(
      sandbox.scrubUrl("wss://token@api.example.com/socket?token=T"),
      "wss://REDACTED@api.example.com/socket?token=REDACTED"
    );
    // 路径里的 '@' 不是凭据,不能被误伤
    assert.equal(
      sandbox.scrubUrl("https://example.com/path?a=b@c"),
      "https://example.com/path?a=b@c"
    );
  });
});

// ── 端到端:导出的 HAR 文件里不能残留任何明文凭据 ────────────────────────────

test("端到端:开启脱敏后导出文件不含任何明文凭据", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });

  const PASSWORD = "hunter2PLAINTEXT";
  const URL_TOKEN = "URLSECRETPLAINTEXT";
  const RESP_TOKEN = "RESPSECRETPLAINTEXT";
  const COOKIE = "COOKIESECRET";

  fireRequest(harness, {
    url: `https://api.example.com/login?token=${URL_TOKEN}`,
    method: "POST",
    requestHeaders: [
      { name: "content-type", value: "application/json" },
      { name: "authorization", value: "Bearer SUPERSECRET==" },
      { name: "cookie", value: `session=${COOKIE}` },
    ],
    requestBody: {
      raw: [{ bytes: new TextEncoder().encode(`{"username":"bob","password":"${PASSWORD}"}`).buffer }],
    },
    responseHeaders: [
      { name: "content-type", value: "text/plain" },
      { name: "set-cookie", value: "sid=SETCOOKIESECRET; Path=/; HttpOnly" },
    ],
    // 响应体里回显的凭据同样必须被清洗
    responseChunks: [chunk(`echo Authorization: Bearer ${RESP_TOKEN}==`)],
  });

  const { raw, har, result } = await exportHAR(harness, { scrubSensitive: true });

  assert.equal(result.success, true);
  for (const secret of [PASSWORD, URL_TOKEN, RESP_TOKEN, "SUPERSECRET", COOKIE, "SETCOOKIESECRET"]) {
    assert.ok(!raw.includes(secret), `导出文件中残留明文凭据: ${secret}`);
  }
  assert.ok(!raw.includes("Bearer"), "Bearer token 未清理");

  // 非敏感信息必须保留 —— 否则"全部删除"也能骗过上面的断言
  assert.ok(raw.includes("bob"), "用户名不应被删除");
  assert.equal(har.log.entries.length, 1);
  assert.equal(har.log.entries[0].request.url, `https://api.example.com/login?token=REDACTED`);
});

test("端到端:未开启脱敏时保留原始数据(默认行为不变)", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });

  const PASSWORD = "hunter2PLAINTEXT";
  fireRequest(harness, {
    url: "https://api.example.com/login?token=URLSECRETPLAINTEXT",
    method: "POST",
    requestHeaders: [{ name: "content-type", value: "application/json" }],
    requestBody: {
      raw: [{ bytes: new TextEncoder().encode(`{"password":"${PASSWORD}"}`).buffer }],
    },
  });

  const { raw } = await exportHAR(harness, { scrubSensitive: false });
  assert.ok(raw.includes(PASSWORD), "默认导出必须保留原始请求体");
  assert.ok(raw.includes("URLSECRETPLAINTEXT"), "默认导出必须保留原始 URL");
});

test("脱敏覆盖 URL 型头部:referer / location 里的凭据不残留", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });

  // 魔法链接 / OAuth 回调场景:落地页 URL 带 token,之后该页发出的每个请求
  // 都会把它重复进 Referer;重定向响应则放在 Location。
  fireRequest(harness, {
    url: "https://api.example.com/x",
    requestHeaders: [
      { name: "content-type", value: "text/plain" },
      { name: "referer", value: "https://app.example.com/cb?token=REFERERSECRET" },
      { name: "origin", value: "https://app.example.com" },
      { name: "accept", value: "application/json" },
    ],
    responseHeaders: [
      { name: "content-type", value: "text/plain" },
      { name: "location", value: "https://app.example.com/next?access_token=LOCATIONSECRET" },
      { name: "content-location", value: "/p#token=CLSECRET" },
    ],
    responseChunks: [chunk("ok")],
  });

  const { raw, har } = await exportHAR(harness, { scrubSensitive: true });
  const entry = har.log.entries[0];
  const headerValue = (list, name) => (list.find(h => h.name === name) || {}).value;

  for (const secret of ["REFERERSECRET", "LOCATIONSECRET", "CLSECRET"]) {
    assert.ok(!raw.includes(secret), `URL 型头部残留凭据: ${secret}`);
  }
  assert.equal(headerValue(entry.request.headers, "referer"), "https://app.example.com/cb?token=REDACTED");
  assert.equal(headerValue(entry.response.headers, "location"), "https://app.example.com/next?access_token=REDACTED");
  // 不含敏感参数 / 非 URL 型的头部不能被误伤
  assert.equal(headerValue(entry.request.headers, "origin"), "https://app.example.com");
  assert.equal(headerValue(entry.request.headers, "accept"), "application/json");
});

test("脱敏后 postData.text 与 postData.params 使用同一占位符", async () => {
  const harness = loadBackground();
  await harness.send({ action: "startRecording" });

  fireRequest(harness, {
    url: "https://api.example.com/form",
    method: "POST",
    requestHeaders: [{ name: "content-type", value: "application/x-www-form-urlencoded" }],
    requestBody: { formData: { user: ["bob"], password: ["hunter2"] } },
  });

  const { har } = await exportHAR(harness, { scrubSensitive: true });
  const postData = har.log.entries[0].request.postData;
  const fromParams = postData.params.find(p => p.name === "password").value;
  assert.ok(postData.text.includes(`password=${fromParams}`),
    `text 与 params 的占位符不一致: text=${postData.text} params=${fromParams}`);
});
