const el = {
  productForm: document.querySelector("#productForm"),
  productBarcode: document.querySelector("#productBarcode"),
  productDescription: document.querySelector("#productDescription"),
  productCost: document.querySelector("#productCost"),
  productQuantity: document.querySelector("#productQuantity"),
  addProductButton: document.querySelector("#addProductButton"),
  incomingForm: document.querySelector("#incomingForm"),
  incomingBarcode: document.querySelector("#incomingBarcode"),
  incomingDescription: document.querySelector("#incomingDescription"),
  incomingCost: document.querySelector("#incomingCost"),
  incomingQuantity: document.querySelector("#incomingQuantity"),
  incomingButton: document.querySelector("#incomingButton"),
  outgoingForm: document.querySelector("#outgoingForm"),
  outgoingBarcode: document.querySelector("#outgoingBarcode"),
  outgoingButton: document.querySelector("#outgoingButton"),
  status: document.querySelector("#status"),
  inventoryBody: document.querySelector("#inventoryBody"),
  incomingLog: document.querySelector("#incomingLog"),
  outgoingLog: document.querySelector("#outgoingLog"),
  inventoryCount: document.querySelector("#inventoryCount"),
  syncStatus: document.querySelector("#syncStatus"),
  inventoryPanel: document.querySelector("#inventoryPanel"),
  incomingPanel: document.querySelector("#incomingPanel"),
  outgoingPanel: document.querySelector("#outgoingPanel"),
  resetButton: document.querySelector("#resetButton"),
  serverNotice: document.querySelector("#serverNotice"),
  hero: document.querySelector(".hero"),
  dashboardView: document.querySelector("#dashboardView"),
  phoneScanner: document.querySelector("#phoneScanner"),
  phoneCameraButton: document.querySelector("#phoneCameraButton"),
  phoneCameraReader: document.querySelector("#phoneCameraReader"),
  scannerOverlay: document.querySelector("#scannerOverlay"),
  phoneScanResult: document.querySelector("#phoneScanResult"),
};

let previousInventory = new Map();
let phoneScanner = null;

function isPhoneScannerView() {
  return window.location.pathname === "/scanner";
}

function isFileMode() {
  return window.location.protocol === "file:";
}

function showServerNotice() {
  if (!isFileMode()) return;
  el.serverNotice.hidden = false;
  setStatus("This page was opened as a file. Open http://localhost:5173 so scans can update inventory.", "warn");
  el.syncStatus.textContent = "Inventory sync offline";
}

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

function getScanModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const mode = String(params.get("mode") || params.get("action") || "smart").toLowerCase();
  return ["incoming", "in", "outgoing", "out"].includes(mode) ? mode : "smart";
}

function getBarcodeFromPageUrl() {
  const params = new URLSearchParams(window.location.search);
  return normalizeScan(
    params.get("barcode") ||
      params.get("sku") ||
      params.get("upc") ||
      params.get("code") ||
      params.get("product") ||
      ""
  );
}

async function api(path, options = {}) {
  if (isFileMode()) {
    throw new Error("Open http://localhost:5173 so the app can reach the inventory server.");
  }

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
  if (isPhoneScannerView()) {
    el.phoneScanResult.textContent = message;
    el.phoneScanResult.className = `phone-result ${tone}`;
  }
}

function money(value) {
  return Number(value || 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

function itemValue(item) {
  return Number(item.cost || 0) * Number(item.quantity || 0);
}

function scannedAt(value, fallback = "") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function flash(element, className) {
  element.classList.remove(className);
  window.requestAnimationFrame(() => {
    element.classList.add(className);
    window.setTimeout(() => element.classList.remove(className), 900);
  });
}

function renderState(data) {
  renderInventory(data.inventory || []);
  renderScanList(el.incomingLog, data.incoming || [], "No incoming scans yet.");
  renderScanList(el.outgoingLog, data.outgoing || [], "No outgoing scans yet.");
}

function renderInventory(items) {
  el.inventoryCount.textContent = `${items.length} ${items.length === 1 ? "product" : "products"} loaded`;

  if (items.length === 0) {
    el.inventoryBody.innerHTML = `
      <tr>
        <td colspan="5">No inventory yet. Scan or create an entry to start.</td>
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
          <td><code>${escapeHtml(item.barcode)}</code></td>
          <td>${escapeHtml(item.description || item.name || "Scanned product")}</td>
          <td>${money(item.cost)}</td>
          <td class="${changed ? "changed" : ""}">${item.quantity}</td>
          <td>${money(itemValue(item))}</td>
        </tr>
      `;
    })
    .join("");

  previousInventory = new Map(items.map((item) => [item.barcode, item.quantity]));
}

function renderScanList(container, entries, emptyText) {
  const visible = entries.slice(0, 8);
  if (visible.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="6">${emptyText}</td>
      </tr>
    `;
    return;
  }

  container.innerHTML = visible
    .map((entry) => {
      return `
        <tr>
          <td>${escapeHtml(scannedAt(entry.time, "Just now"))}</td>
          <td><code>${escapeHtml(entry.barcode || "")}</code></td>
          <td>${escapeHtml(entry.description || "Scanned product")}</td>
          <td>${money(entry.cost)}</td>
          <td>${entry.quantity}</td>
          <td>${money(itemValue(entry))}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadState() {
  try {
    const data = await api("/api/state");
    renderState(data);
    el.syncStatus.textContent = "Inventory sync online";
  } catch (error) {
    el.syncStatus.textContent = "Inventory sync offline";
    throw error;
  }
}

async function scanProduct({ barcode, mode = "smart", description = "", cost = 0, quantity = 1 }) {
  const normalized = normalizeScan(barcode);
  if (!normalized) return;

  setStatus(`Scanned ${normalized}. Updating inventory...`);

  try {
    const result = await api("/api/scan-product", {
      method: "POST",
      body: JSON.stringify({
        barcode: normalized,
        mode,
        description,
        cost,
        quantity,
      }),
    });

    renderState(result);
    if (result.mode === "incoming") {
      setStatus(`${normalized} added to incoming inventory.`, "ok");
      flash(el.incomingPanel, "scan-success");
      flash(el.inventoryPanel, "inventory-updated");
    } else if (result.matched === false) {
      setStatus(`${normalized} is not in inventory yet. Receive it first.`, "warn");
      flash(el.outgoingPanel, "scan-warning");
    } else {
      setStatus(`${normalized} moved to outgoing inventory.`, "ok");
      flash(el.outgoingPanel, "scan-success");
      flash(el.inventoryPanel, "inventory-updated");
    }
  } catch (error) {
    setStatus(error.message, "warn");
    flash(mode === "outgoing" || mode === "out" ? el.outgoingPanel : el.incomingPanel, "scan-warning");
  }
}

async function togglePhoneCamera() {
  if (phoneScanner) {
    await stopPhoneCamera();
    return;
  }

  if (!window.isSecureContext || !navigator.mediaDevices) {
    setStatus("Camera needs HTTPS. Open the localtunnel HTTPS URL on your phone.", "warn");
    return;
  }

  if (!window.Html5Qrcode) {
    setStatus("Camera scanner is still loading. Try again in a second.", "warn");
    return;
  }

  try {
    phoneScanner = new Html5Qrcode("phoneCameraReader", {
      formatsToSupport: getSupportedPhoneFormats(),
    });
    el.phoneCameraButton.textContent = "Stop camera";
    el.scannerOverlay.hidden = false;
    setStatus("Camera is on. Point it at a barcode or QR code.");

    await phoneScanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 260, height: 220 },
        aspectRatio: 1.333,
      },
      async (decodedText) => {
        await scanProduct({
          barcode: decodedText,
          mode: "smart",
          description: `Scanned item ${normalizeScan(decodedText)}`,
          quantity: 1,
        });
      }
    );
  } catch (error) {
    phoneScanner = null;
    el.phoneCameraButton.textContent = "Camera";
    el.scannerOverlay.hidden = true;
    setStatus("Camera permission was blocked or unavailable.", "warn");
  }
}

async function stopPhoneCamera() {
  if (!phoneScanner) return;
  await phoneScanner.stop().catch(() => {});
  phoneScanner.clear();
  phoneScanner = null;
  el.phoneCameraButton.textContent = "Camera";
  el.scannerOverlay.hidden = true;
  setStatus("Camera stopped.");
}

function getSupportedPhoneFormats() {
  if (!window.Html5QrcodeSupportedFormats) return undefined;

  return [
    Html5QrcodeSupportedFormats.QR_CODE,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
  ].filter(Boolean);
}

async function addProduct(event) {
  event.preventDefault();

  const barcode = normalizeScan(el.productBarcode.value);
  const description = el.productDescription.value.trim();
  const cost = Number(el.productCost.value);
  const quantity = Number(el.productQuantity.value);

  if (!barcode || !description || !Number.isFinite(cost) || !Number.isFinite(quantity) || cost < 0 || quantity < 0) {
    setStatus("Enter barcode, description, cost, and quantity.", "warn");
    flash(el.inventoryPanel, "scan-warning");
    return;
  }

  el.addProductButton.disabled = true;
  setStatus(`Creating ${description}...`);

  try {
    const data = await api("/api/products", {
      method: "POST",
      body: JSON.stringify({ barcode, description, cost, quantity }),
    });
    renderState(data);
    el.productForm.reset();
    el.productCost.value = "0";
    el.productQuantity.value = "1";
    el.productBarcode.focus();
    setStatus(`${description} was added to the inventory list.`, "ok");
    flash(el.inventoryPanel, "scan-success");
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.inventoryPanel, "scan-warning");
  } finally {
    el.addProductButton.disabled = false;
  }
}

async function receiveItem(event) {
  event.preventDefault();

  await scanProduct({
    barcode: el.incomingBarcode.value,
    mode: "incoming",
    description: el.incomingDescription.value,
    cost: Number(el.incomingCost.value),
    quantity: Number(el.incomingQuantity.value || 1),
  });

  el.incomingForm.reset();
  el.incomingCost.value = "0";
  el.incomingQuantity.value = "1";
  el.incomingBarcode.focus();
}

async function sendOutItem(event) {
  event.preventDefault();
  await scanProduct({
    barcode: el.outgoingBarcode.value,
    mode: "outgoing",
  });
  el.outgoingForm.reset();
  el.outgoingBarcode.focus();
}

async function resetDemo() {
  const data = await api("/api/reset", { method: "POST" });
  previousInventory = new Map();
  renderState(data);
  setStatus("Demo reset.", "ok");
  el.productBarcode.focus();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

el.productForm.addEventListener("submit", addProduct);
el.incomingForm.addEventListener("submit", receiveItem);
el.outgoingForm.addEventListener("submit", sendOutItem);
el.resetButton.addEventListener("click", resetDemo);
el.phoneCameraButton.addEventListener("click", togglePhoneCamera);

showServerNotice();

if (isPhoneScannerView()) {
  document.body.classList.add("scanner-page");
  el.hero.hidden = true;
  el.dashboardView.hidden = true;
  el.phoneScanner.hidden = false;
  el.serverNotice.hidden = true;
} else {
  document.body.classList.remove("scanner-page");
  el.hero.hidden = false;
  el.dashboardView.hidden = false;
  el.phoneScanner.hidden = true;
}

loadState()
  .then(() => {
    if (isPhoneScannerView()) {
      setStatus("Ready to scan.");
      return;
    }
    const barcodeFromUrl = getBarcodeFromPageUrl();
    if (barcodeFromUrl) {
      scanProduct({
        barcode: barcodeFromUrl,
        mode: getScanModeFromUrl(),
        description: `Scanned item ${barcodeFromUrl}`,
        quantity: 1,
      });
      return;
    }
    el.productBarcode.focus();
  })
  .catch((error) => setStatus(error.message, "warn"));
