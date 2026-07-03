/**
 * Network Logger - Popup Script
 * Handles UI interactions and communicates with the background service worker.
 */

// ─── Theme Toggle ─────────────────────────────────────────────────────────────
const themeToggle = document.getElementById("theme-toggle");

function getPreferredTheme() {
  const stored = localStorage.getItem("nl-theme");
  if (stored) return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "🌙" : "☀️";
  themeToggle.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  localStorage.setItem("nl-theme", theme);
}

applyTheme(getPreferredTheme());

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  themeToggle.style.transition = "transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)";
  themeToggle.style.transform = "rotate(360deg) scale(1.1)";
  setTimeout(() => { themeToggle.style.transform = ""; }, 400);
  applyTheme(current === "dark" ? "light" : "dark");
});

// ─── DOM References ───────────────────────────────────────────────────────────
const btnStart    = document.getElementById("btn-start");
const btnStop     = document.getElementById("btn-stop");
const btnExport   = document.getElementById("btn-export");
const btnClear    = document.getElementById("btn-clear");
const statusBadge = document.getElementById("status-badge");
const requestCount= document.getElementById("request-count");
const elapsedTime = document.getElementById("elapsed-time");
const infoBox     = document.getElementById("info-box");
const infoText    = document.getElementById("info-text");
const filenameInput = document.getElementById("filename-input");
const scrubToggle   = document.getElementById("scrub-toggle");

// ─── State ────────────────────────────────────────────────────────────────────
let isRecording = false;
let recordingStartTime = null;
let timerInterval = null;
let pollInterval = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isContextInvalidated(err) {
  return err && (err.message || "").toLowerCase().includes("extension context invalidated");
}

function sendMsg(action, data = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ action, ...data }, response => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isContextInvalidated(err)) {
            // Service worker was reloaded — reload popup to get a fresh context
            window.location.reload();
            return;
          }
          reject(err);
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      if (isContextInvalidated(e)) {
        window.location.reload();
      } else {
        reject(e);
      }
    }
  });
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const secs = (totalSec % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function setInfo(text, type = "") {
  infoBox.className = "info-box" + (type ? ` ${type}` : "");
  infoText.textContent = "";

  const parts = String(text).split(/(<strong>.*?<\/strong>)/gi);
  for (const part of parts) {
    const strongMatch = /^<strong>(.*?)<\/strong>$/i.exec(part);
    if (strongMatch) {
      const strong = document.createElement("strong");
      strong.textContent = strongMatch[1];
      infoText.appendChild(strong);
    } else if (part) {
      infoText.appendChild(document.createTextNode(part));
    }
  }
}

function updateUI(recording, count = 0) {
  isRecording = recording;
  const statsBar = document.querySelector(".stats-bar");

  if (recording) {
    statusBadge.textContent = "● REC";
    statusBadge.className = "status-badge recording";
    statsBar.classList.add("recording");
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnExport.disabled = true;
    btnClear.disabled = true;
    setInfo("🔴 Recording… capturing all network traffic.", "warning");
    // Hide export options during recording (can't export yet)
    document.querySelector(".options-panel").style.display = "none";
    document.querySelector(".export-section").style.display = "none";
    document.getElementById("security-notice").style.display = "none";
  } else {
    statsBar.classList.remove("recording");
    if (count > 0) {
      statusBadge.textContent = "● READY";
      statusBadge.className = "status-badge stopped";
      setInfo(`✅ Captured <strong>${count}</strong> request${count !== 1 ? "s" : ""}. Ready to export.`, "success");
      btnExport.disabled = false;
      btnClear.disabled = false;
      document.querySelector(".options-panel").style.display = "";
      document.querySelector(".export-section").style.display = "";
      document.getElementById("security-notice").style.display = "";
    } else {
      statusBadge.textContent = "● IDLE";
      statusBadge.className = "status-badge idle";
      setInfo('Press <strong>Start Recording</strong> to begin capturing network requests across all tabs.');
      btnExport.disabled = true;
      btnClear.disabled = true;
      // Hide export options in idle state
      document.querySelector(".options-panel").style.display = "none";
      document.querySelector(".export-section").style.display = "none";
      document.getElementById("security-notice").style.display = "none";
    }
    btnStart.disabled = false;
    btnStop.disabled = true;
  }

  requestCount.textContent = count;
}

function startTimer(startTime) {
  stopTimer();
  recordingStartTime = startTime;
  timerInterval = setInterval(() => {
    elapsedTime.textContent = formatDuration(Date.now() - recordingStartTime);
  }, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    try {
      const res = await sendMsg("getCount");
      if (res && res.count !== parseInt(requestCount.textContent)) {
        requestCount.textContent = res.count;
        requestCount.classList.add("bump");
        setTimeout(() => requestCount.classList.remove("bump"), 200);
      }
    } catch (e) {
      if (isContextInvalidated(e)) {
        stopPolling();
        window.location.reload();
      }
      // else: transient error, retry next tick
    }
  }, 1000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ─── Export HAR ───────────────────────────────────────────────────────────────
async function exportHAR() {
  try {
    btnExport.disabled = true;
    btnExport.innerHTML = '<span class="btn-icon">⏳</span> Exporting…';

    // Delegate the entire download to the background service worker.
    // This ensures the filename is .har and the HAR structure is spec-compliant.
    const customName = filenameInput.value.trim();
    const scrub = scrubToggle.checked;
    const res = await sendMsg("downloadHAR", {
      ...(customName ? { customFilename: customName } : {}),
      scrubSensitive: scrub
    });

    if (!res || !res.success) {
      throw new Error(res?.error || "Download failed");
    }

    const scrubNote = scrub ? " (sensitive data scrubbed)" : "";
    setInfo(`✅ HAR saved — ${res.count} request${res.count !== 1 ? "s" : ""} exported${scrubNote}.`, "success");
    btnExport.disabled = false;
    btnExport.innerHTML = '<span class="btn-icon">⬇</span> Export as HAR';
  } catch (err) {
    setInfo(`❌ Export failed: ${err.message}`, "error");
    btnExport.disabled = false;
    btnExport.innerHTML = '<span class="btn-icon">⬇</span> Export as HAR';
  }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  try {
    const res = await sendMsg("startRecording");
    if (res.success) {
      updateUI(true, 0);
      startTimer(Date.now());
      startPolling();
    }
  } catch (err) {
    setInfo(`❌ Could not start: ${err.message}`, "error");
  }
});

btnStop.addEventListener("click", async () => {
  try {
    const res = await sendMsg("stopRecording");
    stopTimer();
    stopPolling();
    scrubToggle.checked = true;
    updateUI(false, res.count || 0);
  } catch (err) {
    setInfo(`❌ Could not stop: ${err.message}`, "error");
  }
});

btnExport.addEventListener("click", exportHAR);

btnClear.addEventListener("click", async () => {
  try {
    await sendMsg("clearRecording");
    stopTimer();
    stopPolling();
    scrubToggle.checked = true;
    elapsedTime.textContent = "00:00";
    updateUI(false, 0);
  } catch (err) {
    setInfo(`❌ Could not clear: ${err.message}`, "error");
  }
});

// ─── Init: sync with background state ────────────────────────────────────────
(async () => {
  try {
    const status = await sendMsg("getStatus");
    updateUI(status.isRecording, status.count || 0);
    if (status.isRecording && status.startTime) {
      startTimer(status.startTime);
      startPolling();
    } else {
      elapsedTime.textContent = status.isRecording ? "00:00" : formatDuration(0);
    }

    // Apply feature flags to UI
    const featRes = await sendMsg("getFeatures");
    if (featRes && featRes.features) {
      const f = featRes.features;
      if (!f.customFilename) {
        const filenameGroup = document.querySelector(".option-group-label");
        if (filenameGroup) filenameGroup.closest(".option-group").style.display = "none";
      }
      if (!f.scrubbing) {
        const scrubRow = document.querySelector(".scrub-row");
        if (scrubRow) scrubRow.style.display = "none";
      }
      if (!f.customFilename && !f.scrubbing) {
        const panel = document.querySelector(".options-panel");
        if (panel) panel.style.display = "none";
      }
    }
  } catch {
    updateUI(false, 0);
  }
})();
