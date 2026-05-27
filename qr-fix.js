(() => {
  const qrContainer = document.querySelector("#scannerQrCode");
  const link = document.querySelector("#launchScannerLink") || document.querySelector("#phoneScannerLink");

  if (!qrContainer) return;

  function qrFallbackUrl(scannerUrl) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=16&data=${encodeURIComponent(scannerUrl)}`;
  }

  function currentScannerUrl() {
    const fromLink = link?.href || link?.textContent || "";
    if (fromLink && !fromLink.includes("localhost:5443")) return fromLink.trim();
    return `${window.location.origin.replace(/\/$/, "")}/scanner`;
  }

  function installFallback(img, scannerUrl) {
    if (!img || img.dataset.qrFallbackReady === "true") return;
    img.dataset.qrFallbackReady = "true";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.loading = "eager";
    img.alt = `QR code for ${scannerUrl}`;
    img.onerror = () => {
      console.warn("Local QR image failed; using hosted QR fallback.");
      img.onerror = null;
      img.src = qrFallbackUrl(scannerUrl);
    };
  }

  function ensureQrImage() {
    const scannerUrl = currentScannerUrl();
    const existing = qrContainer.querySelector("img");

    if (existing) {
      installFallback(existing, scannerUrl);
      if (!existing.src || existing.naturalWidth === 0) {
        existing.src = `/api/scanner-qr.svg?refresh=${Date.now()}`;
      }
      return;
    }

    const img = document.createElement("img");
    installFallback(img, scannerUrl);
    img.src = `/api/scanner-qr.svg?refresh=${Date.now()}`;
    qrContainer.textContent = "";
    qrContainer.appendChild(img);
  }

  const observer = new MutationObserver(() => ensureQrImage());
  observer.observe(qrContainer, { childList: true, subtree: true });

  window.addEventListener("load", () => window.setTimeout(ensureQrImage, 100));
  window.setTimeout(ensureQrImage, 500);
  window.setTimeout(ensureQrImage, 1500);
})();
