/**
 * Isolated content script. Does not inject the page hook until recording
 * is confirmed, so idle browsing does not fetch page-hook.js on every frame.
 * A weaker Xray fallback is installed only while recording is unknown or
 * on, and is removed once the page is confirmed idle.
 */
(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  if (window.__nlContentHook) return;
  window.__nlContentHook = true;

  const PAGE_HOOK_FLAG = "__nlPH$v1";
  let recording = false;
  let recordingKnown = false;
  let injected = false;
  let fallbackInstalled = false;
  const token = makeToken();
  const pendingStacks = [];
  const MAX_PENDING = 50;
  const saved = {
    fetch: null,
    wrappedFetch: null,
    xhrOpen: null,
    wrappedXhrOpen: null,
    xhrSend: null,
    wrappedXhrSend: null,
    beacon: null,
    wrappedBeacon: null,
    ws: null,
    wrappedWs: null
  };

  function makeToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
  }

  function targetOrigin() {
    try {
      const origin = location.origin;
      return origin && origin !== "null" ? origin : "*";
    } catch {
      return "*";
    }
  }

  function notifyPage() {
    const payload = { source: "nl-control", token: token, via: "cs" };
    if (recordingKnown) payload.recording = recording;
    try {
      window.postMessage(payload, targetOrigin());
    } catch {}
    try {
      const detailRaw = {
        token: token,
        via: "cs",
        recording: recordingKnown ? recording : null
      };
      const detail = (typeof cloneInto === "function")
        ? cloneInto(detailRaw, window)
        : detailRaw;
      const root = document.documentElement || document;
      root.dispatchEvent(new CustomEvent("__nlCS", { detail: detail, bubbles: true }));
    } catch {}
  }

  function deliverStack(via, method, url, stack) {
    try {
      const p = api.runtime.sendMessage({
        action: "initiatorStack",
        url: url,
        method: method,
        stack: stack,
        via: via
      });
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch {}
  }

  function sendStack(via, method, url, stack) {
    if (!recordingKnown) {
      if (pendingStacks.length < MAX_PENDING) {
        pendingStacks.push({ via: via, method: method, url: url, stack: stack });
      }
      return;
    }
    if (!recording) return;
    deliverStack(via, method, url, stack);
  }

  function flushPendingStacks() {
    const batch = pendingStacks.splice(0, pendingStacks.length);
    if (!recording) return;
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      deliverStack(item.via, item.method, item.url, item.stack);
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "nl-initiator") return;
    if (data.token !== token) return;
    sendStack(data.via, data.method, data.url, data.stack);
  });

  let waitingDom = false;
  function setRecording(value) {
    const next = !!value;
    const wasKnown = recordingKnown;
    const wasRec = recording;
    recording = next;
    recordingKnown = true;
    if (recording) {
      hookFallback();
      if (!injectIfNeeded() && !waitingDom) {
        waitingDom = true;
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", function () {
            waitingDom = false;
            if (!injectIfNeeded()) hookFallback();
          }, { once: true });
        } else {
          waitingDom = false;
          if (!injectIfNeeded()) hookFallback();
        }
      }
      // Idle page that later receives Start: drop stacks from before recording.
      // Unknown -> true (new page while already recording): flush the race window.
      if (wasKnown && !wasRec) pendingStacks.length = 0;
      else flushPendingStacks();
    } else {
      pendingStacks.length = 0;
      if (!injected && !pageHookPresent()) unhookFallback();
    }
    notifyPage();
  }

  try {
    api.runtime.onMessage.addListener(function (message) {
      if (!message || message.action !== "nlSetRecording") return;
      setRecording(!!message.recording);
    });
  } catch {}

  let statusTried = false;
  let storageTried = false;
  function maybeIdle() {
    if (recordingKnown) return;
    if (statusTried && storageTried) setRecording(false);
  }

  try {
    api.runtime.sendMessage({ action: "getStatus" }).then(function (status) {
      if (status && status.isRecording) setRecording(true);
      statusTried = true;
      maybeIdle();
    }).catch(function () {
      statusTried = true;
      maybeIdle();
    });
  } catch {
    statusTried = true;
    maybeIdle();
  }

  try {
    api.storage.local.get("isRecording").then(function (state) {
      if (state && state.isRecording) setRecording(true);
      storageTried = true;
      maybeIdle();
    }).catch(function () {
      storageTried = true;
      maybeIdle();
    });
  } catch {
    storageTried = true;
    maybeIdle();
  }

  try {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes.isRecording) return;
      setRecording(!!changes.isRecording.newValue);
    });
  } catch {}

  setTimeout(function () {
    if (!recordingKnown) setRecording(false);
  }, 500);

  function inputToUrl(input) {
    if (input == null || input === "") return "";
    if (typeof input === "string") return input;
    try {
      if (typeof URL !== "undefined" && input instanceof URL) return input.href;
    } catch {}
    if (typeof input === "object") {
      if (typeof input.url === "string") return input.url;
      if (typeof input.href === "string") return input.href;
    }
    return "";
  }

  function pageHookPresent() {
    try {
      const pageWindow = window.wrappedJSObject;
      return !!(pageWindow && Object.prototype.hasOwnProperty.call(pageWindow, PAGE_HOOK_FLAG));
    } catch {
      return false;
    }
  }

  function hookFallback() {
    if (fallbackInstalled) return;
    const pageWindow = window.wrappedJSObject;
    if (!pageWindow || typeof exportFunction !== "function") return;
    const xhrMeta = new WeakMap();

    function report(via, method, url) {
      if (pageHookPresent()) return;
      if (recordingKnown && !recording) return;
      const raw = inputToUrl(url);
      if (!raw) return;
      let resolved = "";
      try {
        resolved = new URL(raw, document.baseURI || location.href).href;
      } catch {
        return;
      }
      let stack = "";
      try { stack = String(new Error().stack || ""); } catch {}
      sendStack(via, String(method || "GET").toUpperCase(), resolved, stack);
    }

    try {
      const origFetch = pageWindow.fetch;
      if (typeof origFetch === "function") {
        saved.fetch = origFetch;
        saved.wrappedFetch = exportFunction(function (input, init) {
          try {
            const method = (init && init.method) || (input && input.method) || "GET";
            report("fetch", method, input);
          } catch {}
          return origFetch.apply(this, arguments);
        }, window, { allowCrossOriginArguments: true });
        pageWindow.fetch = saved.wrappedFetch;
      }
    } catch {}

    try {
      const proto = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
      if (proto && proto.open && proto.send) {
        saved.xhrOpen = proto.open;
        saved.xhrSend = proto.send;
        const origOpen = proto.open;
        const origSend = proto.send;
        saved.wrappedXhrOpen = exportFunction(function (method, url) {
          try { xhrMeta.set(this, { method: method, url: url }); } catch {}
          return origOpen.apply(this, arguments);
        }, window, { allowCrossOriginArguments: true });
        saved.wrappedXhrSend = exportFunction(function () {
          try {
            const meta = xhrMeta.get(this);
            if (meta) report("xhr", meta.method || "GET", meta.url);
          } catch {}
          return origSend.apply(this, arguments);
        }, window, { allowCrossOriginArguments: true });
        proto.open = saved.wrappedXhrOpen;
        proto.send = saved.wrappedXhrSend;
      }
    } catch {}

    try {
      if (pageWindow.navigator && pageWindow.navigator.sendBeacon) {
        const origBeacon = pageWindow.navigator.sendBeacon;
        saved.beacon = origBeacon;
        saved.wrappedBeacon = exportFunction(function (url, data) {
          try { report("beacon", "POST", url); } catch {}
          return origBeacon.call(pageWindow.navigator, url, data);
        }, window, { allowCrossOriginArguments: true });
        pageWindow.navigator.sendBeacon = saved.wrappedBeacon;
      }
    } catch {}

    try {
      const OrigWS = pageWindow.WebSocket;
      if (typeof OrigWS === "function") {
        saved.ws = OrigWS;
        saved.wrappedWs = exportFunction(function (url, protocols) {
          try { report("websocket", "GET", url); } catch {}
          return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
        }, window, { allowCrossOriginArguments: true });
        try { Object.setPrototypeOf(saved.wrappedWs, OrigWS); } catch {}
        saved.wrappedWs.prototype = OrigWS.prototype;
        try {
          saved.wrappedWs.CONNECTING = OrigWS.CONNECTING;
          saved.wrappedWs.OPEN = OrigWS.OPEN;
          saved.wrappedWs.CLOSING = OrigWS.CLOSING;
          saved.wrappedWs.CLOSED = OrigWS.CLOSED;
        } catch {}
        pageWindow.WebSocket = saved.wrappedWs;
      }
    } catch {}

    fallbackInstalled = true;
  }

  function stillOurs(current, wrapped) {
    if (!current || !wrapped) return false;
    if (current === wrapped) return true;
    try { if (current.wrappedJSObject === wrapped) return true; } catch {}
    try { if (wrapped.wrappedJSObject && current === wrapped.wrappedJSObject) return true; } catch {}
    return false;
  }

  function unhookFallback() {
    if (!fallbackInstalled) return;
    const pageWindow = window.wrappedJSObject;
    try {
      if (pageWindow && saved.fetch && stillOurs(pageWindow.fetch, saved.wrappedFetch)) {
        pageWindow.fetch = saved.fetch;
      }
    } catch {}
    try {
      const proto = pageWindow && pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
      if (proto) {
        if (saved.xhrOpen && stillOurs(proto.open, saved.wrappedXhrOpen)) proto.open = saved.xhrOpen;
        if (saved.xhrSend && stillOurs(proto.send, saved.wrappedXhrSend)) proto.send = saved.xhrSend;
      }
    } catch {}
    try {
      if (pageWindow && pageWindow.navigator && saved.beacon &&
          stillOurs(pageWindow.navigator.sendBeacon, saved.wrappedBeacon)) {
        pageWindow.navigator.sendBeacon = saved.beacon;
      }
    } catch {}
    try {
      if (pageWindow && saved.ws && stillOurs(pageWindow.WebSocket, saved.wrappedWs)) {
        pageWindow.WebSocket = saved.ws;
      }
    } catch {}
    saved.fetch = null;
    saved.wrappedFetch = null;
    saved.xhrOpen = null;
    saved.wrappedXhrOpen = null;
    saved.xhrSend = null;
    saved.wrappedXhrSend = null;
    saved.beacon = null;
    saved.wrappedBeacon = null;
    saved.ws = null;
    saved.wrappedWs = null;
    fallbackInstalled = false;
  }

  function injectIfNeeded() {
    if (!recording || injected) return true;
    const root = document.documentElement;
    if (!root) return false;
    if (pageHookPresent()) {
      injected = true;
      notifyPage();
      return true;
    }
    injected = true;
    try {
      const s = document.createElement("script");
      s.src = api.runtime.getURL("page-hook.js");
      s.async = false;
      s.dataset.nlRec = "1";
      s.onload = function () { try { s.remove(); } catch {} notifyPage(); };
      s.onerror = function () { try { s.remove(); } catch {} hookFallback(); };
      root.appendChild(s);
      notifyPage();
      return true;
    } catch {
      injected = false;
      hookFallback();
      return true;
    }
  }

  notifyPage();
  hookFallback();
})();
