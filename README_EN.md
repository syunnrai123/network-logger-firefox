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

HAR files may contain sensitive information such as accounts, passwords, tokens, and cookies. Store and share them carefully.

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

## Usage

1. Click the Network Logger icon in the browser toolbar
2. Click `Start Recording`
3. Perform the actions you want to record on any page
4. Click `Stop Recording`
5. Optionally enter a filename and choose whether to scrub sensitive data
6. Click `Export as HAR`

## Known Limitations

- Requests sent before recording starts are not captured
- Single response bodies over 50MB or request bodies over 8MB are truncated (the response still streams to the page normally); exports mark this via `_bodyTruncated` / `postData._error`. A session is also capped at 50,000 entries (including redirect hops) and about 400MB of captured bodies; the oldest requests are evicted first
- Redirect chains are expanded into one HAR entry per hop (`_redirectChain` / `_redirectIndex`), keeping intermediate Set-Cookie and Location values. Firefox re-fires `onBeforeRequest` with the same `requestId` after a redirect; continuation hops update URL/method only and do not replace hops/body/call stack. A normal 302 keeps the first `filterResponseData`; HSTS/internal upgrades invalidate that channel (`Invalid request ID`), so the continuation disconnects the dead filter and reattaches to keep the final HTML body
- Page JS call stacks are attached for fetch/XHR/beacon/WebSocket handshakes (`_callStack` / `_initiatorType`); parser-driven script/img loads, service-worker / Worker-internal requests, and `EventSource` have no JS stack. `page-hook.js` is not fetched unless recording. A weaker isolated-world fallback is installed only while recording is unknown or on, and is removed once getStatus/storage confirm idle (if the page already replaced `fetch`, it is left alone). Start and background restore broadcast an inject into already-open pages. If CSP blocks the script, the weaker fallback remains (`fetch(new URL(...))` is resolved). The control token is delivered with a synchronous CustomEvent; pages cannot bind or disable the hook with a token-less `postMessage`
- Restricted schemes (`about:`, `moz-extension:`) cannot expose HTTP bodies via webRequest; they are recorded as navigation entries via webNavigation (`_captureSource: webNavigation`). `about:blank` is skipped as noise. committed/error for the same restricted URL within ~2s are merged; later revisits are kept as separate entries
- Private windows require enabling the add-on in about:addons; the popup warns when access is not granted
- Failed requests are kept with `status: 0`; the failure reason is recorded in the `response._error` extension field
- Response bodies of image, imageset (srcset), and media resources are not cached (fonts are kept for font reverse engineering); their `content.size` is taken from content-length (possibly the compressed size)

## Exported Field Notes

To help with reverse engineering, the exported HAR carries these extra fields beyond the standard ones (underscore-prefixed; HAR consumers ignore unknown fields):

- `request._resourceType` — resource type (image/script/xhr/font/websocket, etc.)
- Entry-level `_originUrl` / `_documentUrl` — the initiating URL and the document URL of the request
- Entry-level `_tabId` / `_frameId` / `_parentFrameId` / `_incognito` / `_thirdParty` — request ownership context
- Entry-level `_callStack` / `_initiatorType` / `_frameAncestors` — page call stack, initiator kind, iframe ancestors
- Entry-level `_redirectChain` / `_redirectIndex` / `_redirectId` — per-hop redirect info
- Entry-level `_captureSource` — `webRequest` or `webNavigation` (restricted-scheme navigations)
- Entry-level `_ip` / `_fromCache` / `_proxyInfo` — server IP, cache hit, proxy info
- `response._error` — failure reason for failed requests (e.g. DNS resolution failed, connection refused)
- `response.content._decodedFrom` — original transfer encoding (gzip/br); `content.text` is the decompressed content
- `response.content._bodySkipped` — response bodies of image/imageset/media were skipped by policy
- `response.content._bodyTruncated` — response body exceeded the retention cap; `content.text` is the truncated portion
- `request.postData._error` — reason when the request body capture was limited or truncated

`log.pages` groups requests by tab; each entry links to its page via `pageref`.

## Source Attribution

This project is a Firefox-compatible modification based on:

<https://github.com/themindfuel-ai/network-logger>

The original project name, icons, interface, and main product idea come from that project. This version focuses on Firefox WebExtension compatibility, request/response body capture, and export behavior adaptation.
