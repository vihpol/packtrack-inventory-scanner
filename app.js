const el = {
  scanForm: document.querySelector("#scanForm"),
  scanInput: document.querySelector("#scanInput"),
  scanButton: document.querySelector("#scanButton"),
  status: document.querySelector("#status"),
  inventoryBody: document.querySelector("#inventoryBody"),
  inventoryCount: document.querySelector("#inventoryCount"),
  syncStatus: document.querySelector("#syncStatus"),
  scannerPanel: document.querySelector("#scannerPanel"),
  inventoryPanel: document.querySelector("#inventoryPanel"),
  lastScanPanel: document.querySelector("#lastScanPanel"),
  unknownScanPanel: document.querySelector("#unknownScanPanel"),
  unknownCode: document.querySelector("#unknownCode"),
  resetButton: document.querySelector("#resetButton"),
  scanLog: document.querySelector("#scanLog"),
  cameraButton: document.querySelector("#cameraButton"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraFrame: document.querySelector(".camera-frame"),
};

let previousInventory = new Map();
let scannerBuffer = "";
let scannerTimer = null;
let inputScanTimer = null;
let scanInFlight = false;
let lastSubmittedBarcode = "";
let lastSubmittedAt = 0;
let cameraStream = null;
let detector = null;
let cameraActive = false;

function normalizeScan(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw, window.location.origin);
    const fromUrl =
      url.searchParams.get("barcode") ||
      url.searchParams.get("sku") ||
      url.searchParams.get("upc") ||
      url.searchParams.get("code") ||
      url.searchParams.get("product");
    if (fromUrl) return fromUrl.trim().toUpperCase();
  } catch (error) {
    // Not a URL; treat it as a normal scanned barcode.
  }

  return raw.replace(/[\r\n\t]/g, "").toUpperCase();
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6000);

  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    ...options,
  }).catch((error) => {
    if (error.name === "AbortError") {
      throw new Error("Inventory server did not respond. Check the network or backend.");
    }
    throw new Error("Inventory server is unreachable.");
  });

  window.clearTimeout(timeout);

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

function setStatus(message, tone = "") {
  el.status.textContent = message;
  el.status.className = `status ${tone}`;
}

function flash(element, className) {
  element.classList.remove(className);
  window.requestAnimationFrame(() => {
    element.classList.add(className);
    window.setTimeout(() => element.classList.remove(className), 900);
  });
}

function renderInventory(items) {
  el.inventoryCount.textContent = `${items.length} ${items.length === 1 ? "product" : "products"} loaded`;

  if (items.length === 0) {
    el.inventoryBody.innerHTML = `
      <tr>
        <td colspan="3">No registered products loaded yet.</td>
      </tr>
    `;
    previousInventory = new Map();
    return;
  }

  el.inventoryBody.innerHTML = items
    .map((item) => {
      const previous = previousInventory.get(item.barcode);
      const changed = previous !== undefined && previous !== item.quantity;
      return `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(item.barcode)}</td>
          <td class="${changed ? "changed" : ""}">${item.quantity}</td>
        </tr>
      `;
    })
    .join("");

  previousInventory = new Map(items.map((item) => [item.barcode, item.quantity]));
}

function renderLog(activity) {
  const latest = activity[0];
  el.scanLog.textContent = latest ? `${latest.type}: ${latest.details}` : "No product scanned yet.";
}

function renderUnknownScan(barcode) {
  if (!barcode) {
    el.unknownScanPanel.hidden = true;
    el.unknownCode.textContent = "";
    return;
  }

  el.unknownCode.textContent = barcode;
  el.unknownScanPanel.hidden = false;
  flash(el.unknownScanPanel, "scan-warning");
}

async function loadState() {
  try {
    const data = await api("/api/state");
    renderInventory(data.inventory);
    renderLog(data.activity);
    el.syncStatus.textContent = "Inventory sync online";
  } catch (error) {
    el.syncStatus.textContent = "Inventory sync offline";
    throw error;
  }
}

function getBarcodeFromPageUrl() {
  return normalizeScan(window.location.href);
}

async function scanProduct(value) {
  const barcode = normalizeScan(value);
  if (!barcode) return;
  if (scanInFlight) return;

  const now = Date.now();
  if (barcode === lastSubmittedBarcode && now - lastSubmittedAt < 1800) {
    setStatus(`${barcode} was just scanned. Duplicate ignored.`, "warn");
    flash(el.scannerPanel, "scan-warning");
    el.scanInput.value = "";
    el.scanInput.focus();
    return;
  }

  setStatus(`Scanned ${barcode}. Updating inventory...`);
  scanInFlight = true;
  lastSubmittedBarcode = barcode;
  lastSubmittedAt = now;
  el.scanButton.disabled = true;
  el.scanInput.disabled = true;

  try {
    const result = await api("/api/scan-product", {
      method: "POST",
      body: JSON.stringify({ barcode }),
    });

    renderInventory(result.inventory);
    renderLog(result.activity);
    if (result.matched === false) {
      renderUnknownScan(result.scannedBarcode || barcode);
      setStatus(`${barcode} was read, but it is not registered in inventory.`, "warn");
      flash(el.scannerPanel, "scan-warning");
    } else {
      renderUnknownScan("");
      setStatus(`${barcode} updated inventory immediately.`, "ok");
      flash(el.scannerPanel, "scan-success");
      flash(el.inventoryPanel, "inventory-updated");
      flash(el.lastScanPanel, "scan-success");
    }
    el.scanInput.value = "";
    el.scanInput.focus();
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.scannerPanel, "scan-warning");
  } finally {
    scanInFlight = false;
    el.scanButton.disabled = false;
    el.scanInput.disabled = false;
    el.scanInput.focus();
  }
}

async function resetDemo() {
  const data = await api("/api/reset", { method: "POST" });
  previousInventory = new Map();
  renderInventory(data.inventory);
  renderLog(data.activity);
  renderUnknownScan("");
  el.scanInput.value = "";
  setStatus("Demo reset.", "ok");
  el.scanInput.focus();
}

function handleScannerKey(event) {
  if (event.target.tagName === "INPUT") return;
  if (event.key === "Enter") {
    scanProduct(scannerBuffer);
    scannerBuffer = "";
    return;
  }
  if (event.key.length !== 1) return;

  scannerBuffer += event.key;
  clearTimeout(scannerTimer);
  scannerTimer = setTimeout(() => {
    scannerBuffer = "";
  }, 250);
}

function scheduleInputScan() {
  window.clearTimeout(inputScanTimer);
  const barcode = normalizeScan(el.scanInput.value);
  if (barcode.length < 4) return;

  inputScanTimer = window.setTimeout(() => {
    scanProduct(el.scanInput.value);
  }, 450);
}

async function toggleCamera() {
  if (cameraStream) {
    stopCamera();
    return;
  }

  if (!("BarcodeDetector" in window)) {
    setStatus("Camera scanning is not supported here. A USB/Bluetooth scanner or manual scan still works.", "warn");
    return;
  }

  try {
    detector = new BarcodeDetector({ formats: ["qr_code", "code_128", "code_39"] });
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    el.cameraPreview.srcObject = cameraStream;
    await el.cameraPreview.play();
    el.cameraFrame.classList.add("camera-on");
    cameraActive = true;
    detectLoop();
  } catch (error) {
    setStatus("Camera permission was blocked or unavailable.", "warn");
  }
}

function stopCamera() {
  cameraActive = false;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  el.cameraPreview.srcObject = null;
  el.cameraFrame.classList.remove("camera-on");
}

async function detectLoop() {
  if (!cameraActive || !detector) return;

  try {
    const codes = await detector.detect(el.cameraPreview);
    if (codes.length > 0) {
      await scanProduct(codes[0].rawValue);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } catch (error) {
    setStatus("Camera scan paused.", "warn");
  }

  requestAnimationFrame(detectLoop);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

el.scanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  window.clearTimeout(inputScanTimer);
  scanProduct(el.scanInput.value);
});
el.scanInput.addEventListener("input", scheduleInputScan);
el.resetButton.addEventListener("click", resetDemo);
el.cameraButton.addEventListener("click", toggleCamera);
document.addEventListener("keydown", handleScannerKey);

loadState()
  .then(() => {
    const barcodeFromUrl = getBarcodeFromPageUrl();
    if (barcodeFromUrl) {
      el.scanInput.value = barcodeFromUrl;
      scanProduct(barcodeFromUrl);
      return;
    }
    el.scanInput.focus();
  })
  .catch((error) => setStatus(error.message, "warn"));
