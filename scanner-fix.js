(() => {
  const button = document.querySelector("#phoneCameraButton");
  const readerElement = document.querySelector("#phoneCameraReader");
  const overlay = document.querySelector("#scannerOverlay");
  const resultElement = document.querySelector("#phoneScanResult");
  const photoInput = document.querySelector("#phonePhotoInput");

  if (!button || !readerElement || !window.location.pathname.endsWith("/scanner")) return;

  let scanner = null;
  let dynamsoftScanner = null;
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
    return active && active.dataset ? active.dataset.scanMode : "smart";
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
      facingMode: { exact: "environment" },
    };
  }

  function barcodeBox() {
    const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const width = Math.max(300, Math.min(760, viewportWidth - 28));
    const height = Math.max(150, Math.min(280, Math.round(width * 0.34)));
    return { width, height };
  }

  function scanConfig({ simple = false } = {}) {
    if (simple) {
      return {
        fps: 8,
        qrbox: barcodeBox(),
        disableFlip: true,
      };
    }

    return {
      fps: 8,
      qrbox: barcodeBox(),
      disableFlip: true,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true,
      },
    };
  }

  function errorText(error) {
    if (!error) return "Unknown camera error";
    if (typeof error === "string") return error;
    return [error.name, error.message].filter(Boolean).join(": ") || String(error);
  }

  async function createDynamsoftScanner() {
    const dynamsoft = window.Dynamsoft;
    const licenseKey = window.DYNAMSOFT_LICENSE_KEY || "";

    if (!dynamsoft || !dynamsoft.BarcodeScanner) return null;

    return new dynamsoft.BarcodeScanner({
      license: licenseKey,
      scanMode: dynamsoft.EnumScanMode ? dynamsoft.EnumScanMode.SM_SINGLE : undefined,
      container: readerElement,
      showResultView: false,
      showUploadImageButton: true,
      showPoweredByDynamsoft: true,
      duplicateForgetTime: 1800,
      scannerViewConfig: {
        container: readerElement,
        cameraSwitchControl: "toggleFrontBack",
        showFlashButton: true,
      },
    });
  }

  async function startDynamsoftScanner() {
    const dynamsoft = window.Dynamsoft;
    if (!dynamsoft || !dynamsoft.BarcodeScanner) return false;

    setScannerStatus("Starting commercial barcode scanner...");
    dynamsoftScanner = await createDynamsoftScanner();
    if (!dynamsoftScanner) return false;

    let handledScan = false;
    const onDecoded = async (result) => {
      const barcodeResult =
        (result && result.barcodeResultItems && result.barcodeResultItems[0]) ||
        (result && result.barcodeResults && result.barcodeResults[0]) ||
        result;
      const decodedText =
        (barcodeResult && (barcodeResult.text || barcodeResult.barcodeText || barcodeResult.decodedText)) ||
        (typeof result === "string" ? result : "");

      if (!decodedText) return;
      handledScan = true;
      await handleDecoded(decodedText, result);
    };

    button.textContent = "Stop camera";
    if (overlay) overlay.hidden = false;
    setScannerStatus("Scanner active. Fill the frame with the full label barcode.");

    if (typeof dynamsoftScanner.launch === "function") {
      const result = await dynamsoftScanner.launch();
      await onDecoded(result);
      if (!handledScan) {
        await stopScanner({ silent: true });
        setScannerStatus("No barcode detected. Try a closer, brighter photo or use the hardware scanner.", "warn");
      }
      return true;
    }

    return false;
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
    if (dynamsoftScanner) {
      if (typeof dynamsoftScanner.hide === "function") {
        await dynamsoftScanner.hide().catch(() => {});
      }
      if (typeof dynamsoftScanner.close === "function") {
        await dynamsoftScanner.close().catch(() => {});
      }
      if (typeof dynamsoftScanner.destroy === "function") {
        await dynamsoftScanner.destroy().catch(() => {});
      }
      dynamsoftScanner = null;
      button.textContent = "Start camera";
      if (overlay) overlay.hidden = true;
      if (!silent) setScannerStatus("Scanner stopped");
    }
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
    const format =
      decodedResult &&
      decodedResult.result &&
      decodedResult.result.format &&
      (decodedResult.result.format.formatName || decodedResult.result.format);
    console.log("SCAN FORMAT:", format || "unknown");

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
    setScannerStatus("Scanner active. Fit the entire long barcode inside the wide scan box.");

    const onScanMiss = (scanError) => {
      console.debug("SCAN ATTEMPT FAILED:", scanError);
    };

    const errors = [];
    const attempts = [
      {
        label: "rear camera",
        camera: cameraConstraints(),
        config: scanConfig(),
      },
      {
        label: "simple rear camera",
        camera: { facingMode: { exact: "environment" } },
        config: scanConfig({ simple: true }),
      },
    ];

    for (const attempt of attempts) {
      try {
        await scanner.start(attempt.camera, attempt.config, handleDecoded, onScanMiss);
        return;
      } catch (error) {
        errors.push(`${attempt.label}: ${errorText(error)}`);
        console.warn(`${attempt.label} start failed:`, error);
      }
    }

    const cameras = await Html5Qrcode.getCameras().catch(() => []);
    if (!cameras.length) {
      throw new Error(errors[0] || "No camera found. Check browser camera permission.");
    }

    const orderedCameras = cameras.slice().sort((a, b) => {
      const aRear = /back|rear|environment/i.test(a.label || "") ? -1 : 0;
      const bRear = /back|rear|environment/i.test(b.label || "") ? -1 : 0;
      return aRear - bRear;
    });

    for (const camera of orderedCameras) {
      try {
        await scanner.start(camera.id, scanConfig({ simple: true }), handleDecoded, onScanMiss);
        return;
      } catch (error) {
        errors.push(`${camera.label || "camera"}: ${errorText(error)}`);
        console.warn("Camera id start failed:", camera, error);
      }
    }

    throw new Error(errors.join(" | "));
  }

  function createScanner() {
    return new Html5Qrcode("phoneCameraReader", {
      formatsToSupport: supportedFormats(),
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    });
  }

  async function scanPhoto(file) {
    if (!file) return;
    if (!window.Html5Qrcode) {
      setScannerStatus("Scanner library is still loading. Try again.", "warn");
      return;
    }

    if (scanner) {
      await stopScanner({ silent: true });
    }

    scanner = createScanner();
    button.textContent = "Start camera";
    if (overlay) overlay.hidden = true;
    setScannerStatus("Reading photo...");

    try {
      const result = await scanner.scanFileV2(file, true);
      const decodedText = result && (result.decodedText || result.text || result);
      if (!decodedText) {
        throw new Error("No barcode found in photo");
      }
      await handleDecoded(decodedText, result);
    } catch (error) {
      console.error("Photo scan failed:", error);
      if (typeof window.playScanPing === "function") window.playScanPing("warn");
      if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
      setScannerStatus("Photo did not read. Fill the photo with the full barcode and keep it sharp.", "warn");
      await stopScanner({ silent: true });
    } finally {
      if (photoInput) photoInput.value = "";
    }
  }

  async function toggleScanner(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    if (scanner) {
      await stopScanner();
      return;
    }
    if (dynamsoftScanner) {
      await stopScanner();
      return;
    }

    try {
      if (typeof window.primeScanAudio === "function") window.primeScanAudio();
      const startedDynamsoft = await startDynamsoftScanner().catch((error) => {
        console.warn("Dynamsoft start failed, falling back to html5-qrcode:", error);
        setScannerStatus("Commercial scanner unavailable. Trying backup scanner...", "warn");
        return false;
      });
      if (!startedDynamsoft) {
        await startScanner();
      }
    } catch (error) {
      scanner = null;
      button.textContent = "Start camera";
      if (overlay) overlay.hidden = true;
      console.error("Camera start failed:", error);
      const message = errorText(error);
      window.__lastCameraError = message;
      if (/notallowed|permission|denied/i.test(message)) {
        setScannerStatus("Camera permission is blocked. Allow camera access in the browser settings, then retry.", "warn");
      } else if (/notfound|no camera|devicesnotfound/i.test(message)) {
        setScannerStatus("No camera was found on this device/browser.", "warn");
      } else if (/notreadable|trackstart|in use/i.test(message)) {
        setScannerStatus("Camera is busy. Close other camera apps/tabs and retry.", "warn");
      } else if (/constraint|overconstrained/i.test(message)) {
        setScannerStatus("Camera settings were rejected by this phone. Refresh and retry.", "warn");
      } else {
        setScannerStatus(`Camera could not start: ${message.slice(0, 90)}`, "warn");
      }
    }
  }

  button.addEventListener("click", toggleScanner, true);
  if (photoInput) {
    photoInput.addEventListener("change", () => {
      scanPhoto(photoInput.files && photoInput.files[0]);
    });
  }
})();
