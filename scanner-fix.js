(() => {
  const button = document.querySelector("#phoneCameraButton");
  const readerElement = document.querySelector("#phoneCameraReader");
  const overlay = document.querySelector("#scannerOverlay");
  const resultElement = document.querySelector("#phoneScanResult");

  if (!button || !readerElement || !window.location.pathname.endsWith("/scanner")) return;

  let scanner = null;
  let scanLocked = false;

  function setScannerStatus(message, tone = "") {
    if (typeof window.setStatus === "function") {
      window.setStatus(message, tone);
      return;
    }
    if (resultElement) {
      resultElement.textContent = message;
      resultElement.className = `phone-result ${tone}`;
    }
  }

  function normalize(value) {
    if (typeof window.normalizeScan === "function") {
      return window.normalizeScan(value);
    }
    return String(value || "").trim().replace(/[\r\n\t]/g, "").toUpperCase();
  }

  function selectedMode() {
    const active = document.querySelector("[data-scan-mode].active");
    return active?.dataset.scanMode || "smart";
  }

  function supportedFormats() {
    const formats = window.Html5QrcodeSupportedFormats;
    if (!formats) return undefined;

    return [
      formats.QR_CODE,
      formats.CODE_128,
      formats.CODE_39,
      formats.CODE_93,
      formats.CODABAR,
      formats.DATA_MATRIX,
      formats.PDF_417,
      formats.ITF,
      formats.EAN_13,
      formats.EAN_8,
      formats.UPC_A,
      formats.UPC_E,
      formats.UPC_EAN_EXTENSION,
      formats.AZTEC,
    ].filter(Boolean);
  }

  function cameraConstraints() {
    return {
      facingMode: "environment",
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      focusMode: "continuous",
      advanced: [
        { focusMode: "continuous" },
        { exposureMode: "continuous" },
        { torch: false },
      ],
    };
  }

  function scanConfig() {
    return {
      fps: 15,
      qrbox: { width: 340, height: 150 },
      aspectRatio: 1.777,
      disableFlip: true,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true,
      },
    };
  }

  async function postScan(barcode) {
    if (typeof window.scanProduct === "function") {
      return window.scanProduct({
        barcode,
        mode: selectedMode(),
        quantity: 1,
      });
    }

    const response = await fetch("/api/scan-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        barcode,
        mode: selectedMode(),
        quantity: 1,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Scan failed");
    return data;
  }

  async function stopScanner({ silent = false } = {}) {
    if (!scanner) return;
    await scanner.stop().catch(() => {});
    scanner.clear();
    scanner = null;
    button.textContent = "Start camera";
    if (overlay) overlay.hidden = true;
    if (!silent) setScannerStatus("Scanner stopped");
  }

  async function handleDecoded(decodedText, decodedResult) {
    if (scanLocked) return;
    scanLocked = true;

    const normalized = normalize(decodedText);
    console.log("SCAN SUCCESS RAW:", decodedText);
    console.log("SCAN SUCCESS NORMALIZED:", normalized);
    console.log("SCAN FORMAT:", decodedResult?.result?.format?.formatName || decodedResult?.result?.format || "unknown");

    setScannerStatus(`${normalized} detected`);

    try {
      const result = await postScan(decodedText);
      if (result && result.matched === false) {
        if (typeof window.playScanPing === "function") window.playScanPing("warn");
        if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
        setScannerStatus(`${normalized} not found`, "warn");
      } else {
        if (typeof window.playScanPing === "function") window.playScanPing("ok");
        if (navigator.vibrate) navigator.vibrate(160);
        setScannerStatus(`${normalized} saved`, "ok");
      }
    } catch (error) {
      if (typeof window.playScanPing === "function") window.playScanPing("warn");
      if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
      setScannerStatus(error.message || "Scan failed", "warn");
    } finally {
      await stopScanner({ silent: true });
      scanLocked = false;
    }
  }

  async function startScanner() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setScannerStatus("Camera needs HTTPS. Open the HTTPS scanner link on your phone.", "warn");
      return;
    }
    if (!window.Html5Qrcode) {
      setScannerStatus("Scanner library is still loading. Try again.", "warn");
      return;
    }

    scanner = new Html5Qrcode("phoneCameraReader", {
      formatsToSupport: supportedFormats(),
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    });

    button.textContent = "Stop camera";
    if (overlay) overlay.hidden = false;
    scanLocked = false;
    setScannerStatus("Scanner active. Keep the full switch barcode horizontal inside the wide scan box.");

    await scanner.start(
      cameraConstraints(),
      scanConfig(),
      handleDecoded,
      (scanError) => {
        console.debug("SCAN ATTEMPT FAILED:", scanError);
      }
    );
  }

  async function toggleScanner(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    if (scanner) {
      await stopScanner();
      return;
    }

    try {
      if (typeof window.primeScanAudio === "function") window.primeScanAudio();
      await startScanner();
    } catch (error) {
      scanner = null;
      button.textContent = "Start camera";
      if (overlay) overlay.hidden = true;
      console.error("Camera start failed:", error);
      setScannerStatus("Camera access unavailable. Move farther back, allow camera permission, and retry.", "warn");
    }
  }

  button.addEventListener("click", toggleScanner, true);
})();
