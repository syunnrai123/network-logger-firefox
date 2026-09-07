/**
 * Runs in the page JS world so Error().stack is the page call stack.
 * Only reports while recording, and only with the token the content
 * script planted on this script tag / control message.
 */
(function () {
  const FLAG = "__nlPH$v1";
  try {
    if (Object.prototype.hasOwnProperty.call(window, FLAG)) return;
    Object.defineProperty(window, FLAG, {
      value: 1,
      writable: false,
      enumerable: false,
      configurable: false
    });
  } catch {
    if (window[FLAG]) return;
  }

  const script = document.currentScript;
  let token = "";
  try {
    if (script && script.dataset && script.dataset.nlToken) {
      token = script.dataset.nlToken;
      try { delete script.dataset.nlToken; } catch {}
    }
  } catch {}
  // null = recording state not yet known: queue reports until control says.
  let enabled = (script && script.dataset && script.dataset.nlRec === "1") ? true : null;
  const pending = [];
  const MAX_PENDING = 50;

  function targetOrigin() {
    try {
      const origin = location.origin;
      return origin && origin !== "null" ? origin : "*";
    } catch {
      return "*";
    }
  }

  function flushPending() {
    if (!enabled || !token || !pending.length) {
      if (enabled === false) pending.length = 0;
      return;
    }
    const batch = pending.splice(0, pending.length);
    for (let i = 0; i < batch.length; i++) {
      batch[i].token = token;
      postReport(batch[i]);
    }
  }

  function applyControl(data, fromSync) {
    if (!data || !data.token) return;
    if (!token) {
      // Sync CustomEvent from the content script runs in the same turn as
      // inject. postMessage is a queued task and must not bind a token unless
      // recording is already true (backup if CustomEvent was blocked).
      if (!fromSync && data.recording !== true) return;
      token = String(data.token);
    } else if (data.token !== token) {
      return;
    }
    if (typeof data.recording === "boolean") {
      enabled = data.recording;
      if (enabled) flushPending();
      else pending.length = 0;
    }
  }

  window.addEventListener("__nlCS", function (event) {
    applyControl(event && event.detail, true);
  }, true);

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "nl-control") return;
    applyControl(data, false);
  });

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

  function resolveUrl(url) {
    const raw = inputToUrl(url);
    if (!raw) return "";
    try {
      return new URL(raw, document.baseURI || location.href).href;
    } catch {
      return "";
    }
  }

  function postReport(payload) {
    try {
      window.postMessage(payload, targetOrigin());
    } catch {}
  }

  function report(via, method, url) {
    if (enabled === false) return;
    try {
      const resolved = resolveUrl(url);
      if (!resolved) return;
      const payload = {
        source: "nl-initiator",
        token: token,
        via: via,
        method: String(method || "GET").toUpperCase(),
        url: resolved,
        stack: new Error().stack || ""
      };
      if (enabled === true && token) {
        postReport(payload);
        return;
      }
      if (pending.length < MAX_PENDING) pending.push(payload);
    } catch {
      // Never break the page.
    }
  }

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        try {
          const method = (init && init.method) || (input && input.method) || "GET";
          report("fetch", method, input);
        } catch {}
        return origFetch.apply(this, arguments);
      };
    }
  } catch {}

  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    const xhrMeta = new WeakMap();
    proto.open = function (method, url) {
      try { xhrMeta.set(this, { method: method, url: url }); } catch {}
      return origOpen.apply(this, arguments);
    };
    proto.send = function () {
      try {
        const meta = xhrMeta.get(this);
        if (meta) report("xhr", meta.method || "GET", meta.url);
      } catch {}
      return origSend.apply(this, arguments);
    };
  } catch {}

  try {
    if (navigator.sendBeacon) {
      const origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        try { report("beacon", "POST", url); } catch {}
        return origBeacon(url, data);
      };
    }
  } catch {}

  try {
    const OrigWS = window.WebSocket;
    if (typeof OrigWS === "function") {
      class WrappedWS extends OrigWS {
        constructor(url, protocols) {
          try { report("websocket", "GET", url); } catch {}
          if (arguments.length < 2) super(url);
          else super(url, protocols);
        }
      }
      window.WebSocket = WrappedWS;
    }
  } catch {}
})();
