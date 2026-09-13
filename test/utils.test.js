"use strict";

/**
 * 纯函数单元测试。这些函数分支密集(文件名清理、badge 缩写、字符集回退、
 * Cookie 解析),正是最容易出现边界 bug 的地方。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadBackground } = require("./helpers/load-background");

// vm 沙箱里创建的数组/对象与本测试进程不属于同一个 realm,deepStrictEqual 会
// 比较原型链而误报。JSON 往返把它们搬进当前 realm,只比较结构。
const plain = value => JSON.parse(JSON.stringify(value));

function withSandbox(fn) {
  return fn(loadBackground().sandbox);
}

// ── 文件名清理 ────────────────────────────────────────────────────────────────

test("sanitizeFilename 拦截 Windows 保留设备名(含末尾点/空格变体)", () => {
  withSandbox(sandbox => {
    // 这些必须在拼上 .har 之后也不是保留设备名 —— 原实现把末尾点/空格的
    // 剥离放在设备名判断之后,"con." 会先躲过校验再被剥成 "con"。
    for (const input of ["con", "CON", "con.", "con.txt.", "con.txt", "nul.", "aux..", "prn ", "com1.", "lpt9."]) {
      const finalName = `${sandbox.sanitizeFilename(input)}.har`;
      const stem = finalName.replace(/\.har$/, "").split(".")[0];
      assert.ok(
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem),
        `${JSON.stringify(input)} → ${finalName} 是 Windows 保留设备名`
      );
      assert.ok(!/[. ]$/.test(finalName.replace(/\.har$/, "")), `${finalName} 不应以点或空格结尾`);
    }
  });
});

test("sanitizeFilename 阻止路径穿越与非法字符", () => {
  withSandbox(sandbox => {
    assert.equal(sandbox.sanitizeFilename("../../etc/passwd"), ".._.._etc_passwd");
    assert.equal(sandbox.sanitizeFilename("sub/dir/name"), "sub_dir_name");
    assert.equal(sandbox.sanitizeFilename("a\u0000b"), "ab");
    assert.equal(sandbox.sanitizeFilename("C:\\temp\\x"), "C__temp_x");
  });
});

test("sanitizeFilename 处理空值、去重扩展名与超长名", () => {
  withSandbox(sandbox => {
    assert.equal(sandbox.sanitizeFilename("   "), "network-log");
    assert.equal(sandbox.sanitizeFilename("..."), "network-log");
    assert.equal(sandbox.sanitizeFilename("report.har"), "report");
    assert.equal(sandbox.sanitizeFilename("a".repeat(300)).length, 128);
    // 截断到 128 位正好落在点上时不能留下末尾点
    assert.equal(sandbox.sanitizeFilename(`${"a".repeat(127)}.tail`), "a".repeat(127));
  });
});

// ── badge 文本 ────────────────────────────────────────────────────────────────

test("badgeText 在 Firefox badge 宽度内保持可读且不丢末位", () => {
  withSandbox(sandbox => {
    assert.equal(sandbox.badgeText(0), "0");
    assert.equal(sandbox.badgeText(999), "999");
    assert.equal(sandbox.badgeText(1000), "1k");
    assert.equal(sandbox.badgeText(1234), "1.2k");
    assert.equal(sandbox.badgeText(15400), "15k");
    assert.equal(sandbox.badgeText(99999), "99k");
    assert.equal(sandbox.badgeText(100000), "99k+");
    assert.equal(sandbox.badgeText(500000), "99k+");
    for (const n of [1, 999, 1234, 15400, 99999, 100000]) {
      assert.ok(sandbox.badgeText(n).length <= 4, `${n} 的徽章文本超过 4 字符`);
    }
  });
});

// ── 头部与 Cookie 解析 ────────────────────────────────────────────────────────

test("parseHeaders 兼容数组与对象两种形态", () => {
  withSandbox(sandbox => {
    assert.deepEqual(
      plain(sandbox.parseHeaders([{ name: "A", value: 1 }])),
      [{ name: "A", value: "1" }]
    );
    assert.deepEqual(
      plain(sandbox.parseHeaders({ A: "1" })),
      [{ name: "A", value: "1" }]
    );
    assert.deepEqual(plain(sandbox.parseHeaders(null)), []);
  });
});

test("getHeaderValue 大小写不敏感", () => {
  withSandbox(sandbox => {
    const headers = [{ name: "Content-Type", value: "text/html" }];
    assert.equal(sandbox.getHeaderValue(headers, "content-type"), "text/html");
    assert.equal(sandbox.getHeaderValue(headers, "missing"), "");
  });
});

test("parseRequestCookies 跳过空段并按第一个 = 切分", () => {
  withSandbox(sandbox => {
    assert.deepEqual(
      plain(sandbox.parseRequestCookies([{ name: "Cookie", value: "a=1;;b=2; flag" }])),
      [{ name: "a", value: "1" }, { name: "b", value: "2" }, { name: "flag", value: "" }]
    );
    assert.deepEqual(
      plain(sandbox.parseRequestCookies([{ name: "Cookie", value: "jwt=a=b=c" }])),
      [{ name: "jwt", value: "a=b=c" }]
    );
    assert.deepEqual(plain(sandbox.parseRequestCookies([])), []);
  });
});

test("parseResponseCookies 解析属性并支持多个 Set-Cookie", () => {
  withSandbox(sandbox => {
    const cookies = plain(sandbox.parseResponseCookies([
      { name: "Set-Cookie", value: "sid=abc; Path=/; Domain=example.com; HttpOnly; Secure; Max-Age=60; SameSite=Lax" },
      { name: "set-cookie", value: "other=1" },
    ]));
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0].name, "sid");
    assert.equal(cookies[0].path, "/");
    assert.equal(cookies[0].domain, "example.com");
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].maxAge, 60);
    assert.equal(cookies[0].sameSite, "Lax");
  });
});

// ── 字符集与协议 ──────────────────────────────────────────────────────────────

test("bytesToHarBody 对合法 UTF-8 优先按 UTF-8 解码,忽略错误的 charset 声明", () => {
  withSandbox(sandbox => {
    const text = "中文内容";
    const bytes = new TextEncoder().encode(text);
    const out = sandbox.bytesToHarBody(bytes, [{ name: "content-type", value: "text/plain; charset=iso-8859-1" }]);
    assert.equal(out.text, text, "iso-8859-1 声明不应把合法 UTF-8 解成乱码");
    assert.equal(out.encoded, false);
  });
});

test("bytesToHarBody 在字节非合法 UTF-8 时信任声明的 charset", () => {
  withSandbox(sandbox => {
    // GBK 编码的 "中文"
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    assert.equal(sandbox.tryDecodeUtf8(gbk), null, "前置条件:该字节序列不是合法 UTF-8");
    const out = sandbox.bytesToHarBody(gbk, [{ name: "content-type", value: "text/plain; charset=gbk" }]);
    assert.equal(out.text, "中文");
    assert.equal(out.encoded, false);
  });
});

test("bytesToHarBody 对未知 charset 声明回退到 UTF-8 而不抛异常", () => {
  withSandbox(sandbox => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    const out = sandbox.bytesToHarBody(bytes, [{ name: "content-type", value: "text/plain; charset=x-not-a-real-charset" }]);
    assert.equal(typeof out.text, "string");
    assert.equal(out.encoded, false);
  });
});

test("bytesToHarBody 对非文本类型且非法 UTF-8 的字节走 base64", () => {
  withSandbox(sandbox => {
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x80]);
    const out = sandbox.bytesToHarBody(bytes, [{ name: "content-type", value: "application/octet-stream" }]);
    assert.equal(out.encoded, true);
    assert.equal(typeof out.text, "string");
  });
});

test("getCharset 解析引号包裹与缺失的 charset", () => {
  withSandbox(sandbox => {
    assert.equal(sandbox.getCharset([{ name: "content-type", value: 'text/html; charset="gbk"' }]), "gbk");
    assert.equal(sandbox.getCharset([{ name: "content-type", value: "text/html" }]), "utf-8");
  });
});

test("httpVer 优先信任 protocol 参数并在缺失时回退 statusLine", () => {
  withSandbox(sandbox => {
    assert.equal(sandbox.httpVer("HTTP/2", "HTTP/1.1 200"), "h2");
    assert.equal(sandbox.httpVer("HTTP/3", ""), "h3");
    assert.equal(sandbox.httpVer(null, "HTTP/1.1 200"), "HTTP/1.1");
    assert.equal(sandbox.httpVer(null, "HTTP/2 200"), "h2");
  });
});

test("parseQueryString 对畸形 URL 返回空数组而不抛异常", () => {
  withSandbox(sandbox => {
    assert.deepEqual(plain(sandbox.parseQueryString("not a url")), []);
    assert.deepEqual(
      plain(sandbox.parseQueryString("https://x.com/p?a=1&b=2")),
      [{ name: "a", value: "1" }, { name: "b", value: "2" }]
    );
  });
});

// ── 请求体提取 ────────────────────────────────────────────────────────────────

test("extractRequestBody 解析 formData 为 params 与 URL 编码 text", () => {
  withSandbox(sandbox => {
    const result = sandbox.extractRequestBody({ formData: { a: ["1"], b: ["x", "y"] } });
    assert.deepEqual(plain(result.params), [
      { name: "a", value: "1" },
      { name: "b", value: "x" },
      { name: "b", value: "y" },
    ]);
    assert.equal(result.text, "a=1&b=x&b=y");
  });
});

test("extractRequestBody 标注未随 raw 提供内容的文件段", () => {
  withSandbox(sandbox => {
    // multipart 上传:Firefox 不暴露文件字节,只在 raw 里给出路径占位
    const result = sandbox.extractRequestBody({
      raw: [
        { bytes: new TextEncoder().encode("--boundary\r\nfield=1\r\n").buffer },
        { file: "C:\\secret\\payload.bin" },
      ],
    });
    assert.match(result.error, /File part content not captured/, "必须标注请求体存在空洞");
    assert.ok(result.rawChunks, "内联字段仍要保留");
  });
});

test("extractRequestBody 仅在只有文件段时合成 text", () => {
  withSandbox(sandbox => {
    const result = sandbox.extractRequestBody({ raw: [{ file: "/tmp/a.bin" }] });
    assert.equal(result.text, "[file:/tmp/a.bin]");
    assert.equal(result.rawChunks, null);
  });
});

// ── 响应体跳过策略 ────────────────────────────────────────────────────────────

test("image/media 不建滤波器,font 保留", async () => {
  const { loadBackground, fireRequest } = require("./helpers/load-background");
  const images = loadBackground();
  await images.send({ action: "startRecording" });
  fireRequest(images, { type: "image" });
  assert.equal(images.state.filters.length, 0, "image 不应创建滤波器");

  const fonts = loadBackground();
  await fonts.send({ action: "startRecording" });
  fireRequest(fonts, { type: "font" });
  assert.equal(fonts.state.filters.length, 1, "font 必须保留(字体逆向依赖原始二进制)");
});
