const el = {
  scanForm: document.querySelector("#scanForm"),
  scanInput: document.querySelector("#scanInput"),
  status: document.querySelector("#status"),
  inventoryBody: document.querySelector("#inventoryBody"),
  inventoryCount: document.querySelector("#inventoryCount"),
  scannerPanel: document.querySelector("#scannerPanel"),
  inventoryPanel: document.querySelector("#inventoryPanel"),
  lastScanPanel: document.querySelector("#lastScanPanel"),
  resetButton: document.querySelector("#resetButton"),
  scanLog: document.querySelector("#scanLog"),
  cameraButton: document.querySelector("#cameraButton"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraFrame: document.querySelector(".camera-frame"),
};

let previousInventory = new Map();
let scannerBuffer = "";
let scannerTimer = null;
let cameraStream = null;
let detector = null;
let cameraActive = false;

function normalizeScan(value) {
  return String(value || "").trim().toUpperCase();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
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

async function loadState() {
  const data = await api("/api/state");
  renderInventory(data.inventory);
  renderLog(data.activity);
}

async function scanProduct(value) {
  const barcode = normalizeScan(value);
  if (!barcode) return;

  setStatus(`Scanned ${barcode}. Updating inventory...`);

  try {
    const result = await api("/api/scan-product", {
      method: "POST",
      body: JSON.stringify({ barcode }),
    });

    renderInventory(result.inventory);
    renderLog(result.activity);
    setStatus(`${barcode} updated inventory immediately.`, "ok");
    flash(el.scannerPanel, "scan-success");
    flash(el.inventoryPanel, "inventory-updated");
    flash(el.lastScanPanel, "scan-success");
    el.scanInput.value = "";
    el.scanInput.focus();
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.scannerPanel, "scan-warning");
  }
}

async function resetDemo() {
  const data = await api("/api/reset", { method: "POST" });
  previousInventory = new Map();
  renderInventory(data.inventory);
  renderLog(data.activity);
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
  scanProduct(el.scanInput.value);
});
el.resetButton.addEventListener("click", resetDemo);
el.cameraButton.addEventListener("click", toggleCamera);
document.addEventListener("keydown", handleScannerKey);

loadState()
  .then(() => el.scanInput.focus())
  .catch((error) => setStatus(error.message, "warn"));
