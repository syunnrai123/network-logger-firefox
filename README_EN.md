# Network Logger - Firefox HAR Exporter

[中文](README.md) | [English](README_EN.md)

This is a Firefox network logging extension that captures network requests across browser tabs and exports them as HAR 1.2 files.

This project is modified from [themindfuel-ai/network-logger](https://github.com/themindfuel-ai/network-logger). The main goal of this version is Firefox compatibility while preserving the original HAR export workflow.

## Features

- Capture network requests from regular Firefox web pages
- Support cross-page and cross-tab recording
- Export standard HAR 1.2 files
- Capture request headers, response headers, request bodies, and response bodies
- Support custom export filenames
- Optional sensitive data scrubbing

## Firefox Compatibility Changes

The original project mainly relies on Chrome MV3 `chrome.debugger` / CDP APIs to collect complete network data. Firefox extensions do not provide an equivalent Chrome Debugger API, so this version uses Firefox WebExtension APIs instead:

- Use `webRequest.onBeforeRequest` with `requestBody` to capture request bodies
- Use `webRequest.filterResponseData()` to capture response bodies
- Use `downloads.download()` to export HAR files
- Use a persistent Manifest V2 background script

When capturing response bodies, the extension copies response stream chunks for the HAR file and writes the original bytes back to the browser response stream, so page behavior is not changed.

## Sensitive Data Handling

Sensitive data scrubbing is available, but it is disabled by default.

Data is scrubbed only when the `Scrub sensitive data` option is manually enabled before export. By default, exported HAR files preserve the original request bodies and response bodies.

When enabled, scrubbing covers:

- Sensitive request/response headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, ...) and the values in the `cookies` arrays
- URL-bearing headers (`referer`, `location`, `content-location`, `origin`) scrubbed with the URL rules — with magic links, the landing page's token would otherwise reappear in the Referer of every later request
- Sensitive query parameters in the URL, the **URL fragment** (OAuth implicit-flow `#access_token=…` and hash-routed queries), and `userinfo` credentials
- `Bearer` credentials, JSON fields, and form fields holding passwords/tokens/secrets in request and response bodies
- Proxy authentication usernames

Note: scrubbing is best-effort and regex-based. It cannot cover custom field names or non-standard credential encodings. Exported HAR files may still contain sensitive information — store and share them carefully.

Known gaps (these slip through and need manual review):

- Parameter names outside the built-in list. The list is deliberately conservative (OAuth's `code` is not included) to avoid colliding with common names such as country, promo, or status codes
- When a `Bearer` credential contains a character outside the base64url set (e.g. `%`, `:`), the portion after that character is not removed (`Bearer abc%20def` → `[REDACTED]%20def`)
- When a JSON value contains an escaped quote (`"password":"he said \"hi\""`), the content after the first escaped quote is not removed. An escape-aware pattern (`(?:[^"\\]|\\.)*`) overflows the regexp backtrack stack on very long (≥8MB) unterminated strings, which would upgrade a partial leak into a failed export, so the current form is kept
- Rare URL-bearing headers such as `link` / `refresh` are not scrubbed

## Installation and Testing

### Load Temporarily in Firefox

1. Open Firefox
2. Go to `about:debugging#/runtime/this-firefox`
3. Click `Load Temporary Add-on...`
4. Select this project's `manifest.json`

### Run With web-ext

If Node.js is installed, you can use Mozilla's `web-ext`:

```powershell
npx --yes web-ext run --source-dir .
```

### Validate the Extension

```powershell
npx --yes web-ext lint --source-dir .
```

The current version passes Firefox extension validation:

- 0 errors
- 0 warnings

### Unit Tests

The tests evaluate `background.js` itself (via `vm`, with a minimal WebExtension API sandbox), so they exercise the shipped file with no build step and no third-party dependencies:

```powershell
npm test
```

They cover export integrity (the artifact must be valid JSON with a conserved entry count), HAR spec fields, the text/base64 body decision, filename sanitization, and the scrubbing paths — including an end-to-end assertion that a scrubbed export contains no plaintext credentials.

## Usage

1. Click the Network Logger icon in the browser toolbar
2. Click `Start Recording`
3. Perform the actions you want to record on any page
4. Click `Stop Recording`
5. Optionally enter a filename and choose whether to scrub sensitive data
6. Click `Export as HAR`

## Known Limitations

- Requests sent before recording starts are not captured
- Firefox internal pages, extension pages, and some browser-reserved pages cannot be captured
- Requests in private windows depend on whether Firefox allows this extension to run in private windows
- Single response bodies over 50MB or request bodies over 8MB are truncated (the response still streams to the page normally); exports mark this via `_bodyTruncated` / `postData._error`
- At most 50000 requests are kept in memory; beyond that the oldest entries are evicted and the count is reported in `log._droppedEntries`. Unlike body truncation, evicted entries are unrecoverable
- Text/base64 body decision: explicitly textual MIME types (`text/*`, json, javascript, xml, ...) are decoded to readable text up to 16MB; other types are decoded when under 1MB and the bytes are valid UTF-8, otherwise base64 (`content.encoding` is `"base64"`)
- Redirect chains record only the initial URL and the final status (the webRequest API does not expose per-hop information)
- Failed requests are kept with `status: 0`; the failure reason is recorded in the `response._error` extension field
- Response bodies of image/media resources are not cached (fonts are kept for font reverse engineering); their `content.size` is taken from content-length (possibly the compressed size)
- `blocked` / `dns` / `connect` / `ssl` in `timings` are always `-1`: the webRequest API does not expose those phases
- With scrubbing enabled, every text body is regex-scrubbed during export; a 16MB-class body adds on the order of a hundred milliseconds each and occupies the background thread while exporting

## Exported Field Notes

To help with reverse engineering, the exported HAR carries these extra fields beyond the standard ones (underscore-prefixed; HAR consumers ignore unknown fields):

- `request._resourceType` — resource type (image/script/xhr/font/websocket, etc.)
- Entry-level `_originUrl` / `_documentUrl` — the initiating URL and the document URL of the request
- Entry-level `_tabId` / `_frameId` / `_incognito` / `_thirdParty` — request ownership context
- Entry-level `_ip` / `_fromCache` / `_proxyInfo` — server IP, cache hit, proxy info
- `response._error` — failure reason for failed requests (e.g. DNS resolution failed, connection refused)
- `response.content._decodedFrom` — original transfer encoding (gzip/br); `content.text` is the decompressed content
- `response.content._bodySkipped` — response bodies of image/media were skipped by policy
- `response.content._bodyTruncated` — response body exceeded the retention cap; `content.text` is the truncated portion
- `request.postData._error` — reason when the request body capture was limited or truncated (including file parts whose content was not provided in `raw` during a multipart upload)
- `log._droppedEntries` — number of requests evicted by the 50000-entry cap; the field's presence means the HAR is incomplete

`response.content.size` is the decompressed content size and `response.bodySize` is the transferred size (taken from content-length, falling back to the content size for chunked transfers); the difference is recorded in `response.content.compression`.

`log.pages` groups requests by tab; each entry links to its page via `pageref`.

## Source Attribution

This project is a Firefox-compatible modification based on:

<https://github.com/themindfuel-ai/network-logger>

The original project name, icons, interface, and main product idea come from that project. This version focuses on Firefox WebExtension compatibility, request/response body capture, and export behavior adaptation.

## License

This repository currently ships **no open-source license**: the upstream `themindfuel-ai/network-logger` declares none either, so this derivative keeps all rights reserved by default. It is intended for local personal use and has no clear basis for public redistribution.

Before publishing or redistributing, confirm whether the upstream author grants permission, then add a LICENSE file (MIT, for example) and declare it in `manifest.json` and the documentation.

A HAR file is as sensitive as the credentials it contains — never share an unscrubbed export publicly.
