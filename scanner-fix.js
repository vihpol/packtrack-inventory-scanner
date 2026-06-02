(() => {
  const photoInput = document.querySelector("#phonePhotoInput");
  const resultElement = document.querySelector("#phoneScanResult");
  const progressElement = document.querySelector("#phoneScanProgress");
  const percentElement = document.querySelector("#phoneScanPercent");

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

  function setProgress(state = "idle", percent = 0) {
    if (!progressElement) return;
    const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent || 0))));
    progressElement.hidden = state === "idle";
    progressElement.className = `phone-progress ${state}`;
    progressElement.style.setProperty("--progress", `${safePercent}%`);
    if (percentElement) percentElement.textContent = `${safePercent}%`;
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
        boxQty: details.boxQty || 0,
        estimatedFields: Array.isArray(details.estimatedFields) ? details.estimatedFields : [],
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
        boxQty: details.boxQty || 0,
        estimatedFields: Array.isArray(details.estimatedFields) ? details.estimatedFields : [],
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
    setProgress("saving", 82);
    setScannerStatus(`Saving ${normalized}...`);

    try {
      const result = await postScan(decodedText, details);
      if (result && result.matched === false) {
        if (typeof window.playScanPing === "function") window.playScanPing("warn");
        if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
        setProgress("failed", 100);
        setScannerStatus(`Failed to save ${normalized}`, "warn");
      } else {
        if (typeof window.playScanPing === "function") window.playScanPing("ok");
        if (navigator.vibrate) navigator.vibrate(160);
        const quantity = Math.max(1, Number(details.quantity || 1));
        const delta = selectedMode() === "outgoing" ? "-1" : `+${quantity}`;
        const detailNote = scanDetailSummary(details);
        const estimateNote = Array.isArray(details.estimatedFields) && details.estimatedFields.length ? " • estimated fields shown on dashboard" : "";
        setProgress("saved", 100);
        setScannerStatus(`Saved ${normalized} (${delta})${detailNote}${estimateNote}`, "ok");
      }
    } catch (error) {
      if (typeof window.playScanPing === "function") window.playScanPing("warn");
      if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
      setProgress("failed", 100);
      setScannerStatus(error.message || "Failed to save scan", "warn");
    } finally {
      scanLocked = false;
    }
  }

  async function scanPhoto(file) {
    if (!file || scanLocked) return;
    setProgress("loading", 8);
    setScannerStatus("Reading label photo...");

    try {
      const image = await imageFileToDataUrl(file);
      setProgress("loading", 32);
      setScannerStatus("Preparing label image...");
      const response = await fetch("/api/analyze-label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      setProgress("loading", 68);
      const analysis = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(analysis.error || "Photo analyzer failed");
      }
      if (!analysis.barcode) {
        throw new Error("No barcode found in photo");
      }
      setProgress("saving", 78);
      await handleDecoded(analysis.barcode, {
        description: analysis.description || "",
        quantity: analysis.quantity || 1,
        labelType: analysis.labelType || "",
        packageId: analysis.packageId || "",
        barcodePrefix: analysis.barcodePrefix || "",
        dpn: analysis.dpn || "",
        modelRef: analysis.modelRef || "",
        origin: analysis.origin || "",
        boxQty: analysis.boxQty || 0,
        estimatedFields: Array.isArray(analysis.estimatedFields) ? analysis.estimatedFields : [],
      });
    } catch (error) {
      console.error("Photo scan failed:", error);
      if (typeof window.playScanPing === "function") window.playScanPing("warn");
      if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
      setProgress("failed", 100);
      setScannerStatus(error.message || "Failed to save scan", "warn");
    } finally {
      photoInput.value = "";
    }
  }

  photoInput.addEventListener("change", () => {
    scanPhoto(photoInput.files && photoInput.files[0]);
  });

  function scanDetailSummary(details = {}) {
    const parts = [
      details.packageId ? `PKG ${details.packageId}` : "",
      details.dpn ? `DP/N ${details.dpn}` : "",
      details.modelRef ? `Ref ${details.modelRef}` : "",
      details.origin || "",
      details.boxQty ? `Box qty ${details.boxQty}` : "",
    ].filter(Boolean);
    return parts.length ? ` • ${parts.join(" • ")}` : "";
  }
})();
