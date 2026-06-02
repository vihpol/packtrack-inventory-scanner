(() => {
  const photoInput = document.querySelector("#phonePhotoInput");
  const resultElement = document.querySelector("#phoneScanResult");

  if (!photoInput || !window.location.pathname.endsWith("/scanner")) return;

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
    const mode = active && active.dataset ? active.dataset.scanMode : "incoming";
    return mode === "outgoing" ? "outgoing" : "incoming";
  }

  function imageFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const reader = new FileReader();

      reader.onload = () => {
        image.onload = () => {
          const maxSide = 3600;
          const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.95));
        };
        image.onerror = () => reject(new Error("Could not read that photo"));
        image.src = reader.result;
      };
      reader.onerror = () => reject(new Error("Could not load that photo"));
      reader.readAsDataURL(file);
    });
  }

  async function postScan(barcode, details = {}) {
    const quantity = Math.max(1, Number(details.quantity || 1));
    if (typeof window.scanProduct === "function") {
      return window.scanProduct({
        barcode,
        mode: selectedMode(),
        description: details.description || "",
        quantity,
        labelType: details.labelType || "",
        packageId: details.packageId || "",
        barcodePrefix: details.barcodePrefix || "",
        dpn: details.dpn || "",
        modelRef: details.modelRef || "",
        origin: details.origin || "",
      });
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    const response = await fetch("/api/scan-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        barcode,
        mode: selectedMode(),
        description: details.description || "",
        quantity,
        labelType: details.labelType || "",
        packageId: details.packageId || "",
        barcodePrefix: details.barcodePrefix || "",
        dpn: details.dpn || "",
        modelRef: details.modelRef || "",
        origin: details.origin || "",
      }),
    }).catch((error) => {
      if (error.name === "AbortError") {
        throw new Error("Inventory update timed out. Check Wi-Fi, then scan again.");
      }
      throw new Error("Inventory server is unreachable.");
    });
    window.clearTimeout(timeout);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Scan failed");
    return data;
  }

  async function handleDecoded(decodedText, details = {}) {
    if (scanLocked) return;
    scanLocked = true;

    const normalized = normalize(decodedText);
    setScannerStatus(`${normalized} decoded by VM`);

    try {
      const result = await postScan(decodedText, details);
      if (result && result.matched === false) {
        if (typeof window.playScanPing === "function") window.playScanPing("warn");
        if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
        setScannerStatus(`${normalized} not found`, "warn");
      } else {
        if (typeof window.playScanPing === "function") window.playScanPing("ok");
        if (navigator.vibrate) navigator.vibrate(160);
        const quantity = Math.max(1, Number(details.quantity || 1));
        const delta = selectedMode() === "outgoing" ? "-1" : `+${quantity}`;
        setScannerStatus(`${normalized} saved (${delta})`, "ok");
      }
    } catch (error) {
      if (typeof window.playScanPing === "function") window.playScanPing("warn");
      if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
      setScannerStatus(error.message || "Scan failed", "warn");
    } finally {
      scanLocked = false;
    }
  }

  async function scanPhoto(file) {
    if (!file || scanLocked) return;
    setScannerStatus("Sending photo to VM decoder...");

    try {
      const image = await imageFileToDataUrl(file);
      const response = await fetch("/api/analyze-label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const analysis = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(analysis.error || "Photo analyzer failed");
      }
      if (!analysis.barcode) {
        throw new Error("No barcode found in photo");
      }
      await handleDecoded(analysis.barcode, {
        description: analysis.description || "",
        quantity: analysis.quantity || 1,
        labelType: analysis.labelType || "",
        packageId: analysis.packageId || "",
        barcodePrefix: analysis.barcodePrefix || "",
        dpn: analysis.dpn || "",
        modelRef: analysis.modelRef || "",
        origin: analysis.origin || "",
      });
    } catch (error) {
      console.error("Photo scan failed:", error);
      if (typeof window.playScanPing === "function") window.playScanPing("warn");
      if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
      setScannerStatus(error.message || "Photo did not read. Fill the photo with the full barcode and keep it sharp.", "warn");
    } finally {
      photoInput.value = "";
    }
  }

  photoInput.addEventListener("change", () => {
    scanPhoto(photoInput.files && photoInput.files[0]);
  });
})();
