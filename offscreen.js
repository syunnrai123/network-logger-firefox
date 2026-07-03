/**
 * Offscreen document script.
 * Receives HAR JSON from the background worker and triggers a real
 * anchor-click download — the only method that 100% preserves the
 * .har filename on all platforms (macOS, Windows, Linux).
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  // Only the background service worker (no tab, same extension) may trigger downloads
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.action !== "triggerHarDownload") return;

  const { json, filename } = message;

  // Build a Blob with a neutral MIME type so the OS never rewrites the extension
  const blob = new Blob([json], { type: "application/octet-stream" });
  const url  = URL.createObjectURL(blob);

  const a       = document.createElement("a");
  a.href        = url;
  a.download    = filename;   // browser MUST use this exact name for anchor downloads
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();

  // Clean up after a short delay
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 5000);
});
