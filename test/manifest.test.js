"use strict";

/**
 * 打包与清单层面的不变量。
 *
 * 版本号曾经硬编码在 manifest.json / background.js(creator.version) /
 * popup.html(footer) 三处,改版本时极易漏改。现在 manifest.json 是唯一来源,
 * 这个文件把"不许再出现第二处"变成可执行的约束 —— 光靠注释挡不住下次改动。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));

test("package.json 版本与 manifest.json 保持一致", () => {
  assert.equal(
    pkg.version,
    manifest.version,
    "两处版本号不一致:manifest.json 是运行时唯一来源,package.json 需同步"
  );
});

test("UI 里不得出现硬编码的扩展版本号", () => {
  // 只匹配三段式语义化版本(v1.2.3 / 1.2.3)。HAR 格式版本 "HAR 1.2" 是规范
  // 常量,不随扩展版本变化,因此不会被误判。
  const semverLike = /v?\d+\.\d+\.\d+/;
  for (const name of ["popup.html", "popup.js", "popup.css"]) {
    const match = read(name).match(semverLike);
    assert.equal(match, null, `${name} 出现硬编码版本号 ${match && match[0]},应改从 manifest 读取`);
  }
  assert.match(read("popup.js"), /getManifest\(\)\.version/, "popup.js 必须从 manifest 取版本号");
});

test("background.js 的 HAR creator.version 取自 manifest", () => {
  const src = read("background.js");
  assert.match(src, /creator:\s*\{[^}]*getManifest\(\)\.version/, "creator.version 必须来自 manifest");
});

test("manifest 声明的权限与实际使用的 API 对得上", () => {
  // filterResponseData 需要 webRequestBlocking(MDN 明确要求),漏掉会在运行期
  // 抛异常;这里同时确认 API 面没有声明多余权限。
  const src = read("background.js");
  if (/filterResponseData/.test(src)) {
    assert.ok(manifest.permissions.includes("webRequestBlocking"),
      "使用了 filterResponseData 却没有声明 webRequestBlocking 权限");
  }
  for (const api of ["webRequest", "downloads", "storage"]) {
    if (new RegExp(`api\\.${api}\\.`).test(src)) {
      assert.ok(manifest.permissions.includes(api), `使用了 ${api} 却未在 manifest 中声明`);
    }
  }
});
