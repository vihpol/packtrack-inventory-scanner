const el = {
  productForm: document.querySelector("#productForm"),
  productName: document.querySelector("#productName"),
  productBarcode: document.querySelector("#productBarcode"),
  productQuantity: document.querySelector("#productQuantity"),
  addProductButton: document.querySelector("#addProductButton"),
  status: document.querySelector("#status"),
  inventoryBody: document.querySelector("#inventoryBody"),
  inventoryCount: document.querySelector("#inventoryCount"),
  syncStatus: document.querySelector("#syncStatus"),
  addProductPanel: document.querySelector("#addProductPanel"),
  inventoryPanel: document.querySelector("#inventoryPanel"),
  lastScanPanel: document.querySelector("#lastScanPanel"),
  unknownScanPanel: document.querySelector("#unknownScanPanel"),
  unknownCode: document.querySelector("#unknownCode"),
  useUnknownButton: document.querySelector("#useUnknownButton"),
  resetButton: document.querySelector("#resetButton"),
  scanLog: document.querySelector("#scanLog"),
  serverNotice: document.querySelector("#serverNotice"),
};

let previousInventory = new Map();
let scanInFlight = false;
let lastSubmittedBarcode = "";
let lastSubmittedAt = 0;

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

async function scanProduct(value) {
  const barcode = normalizeScan(value);
  if (!barcode) return;
  if (scanInFlight) return;

  const now = Date.now();
  if (barcode === lastSubmittedBarcode && now - lastSubmittedAt < 1800) {
    setStatus(`${barcode} was just scanned. Duplicate ignored.`, "warn");
    flash(el.lastScanPanel, "scan-warning");
    return;
  }

  setStatus(`Scanned ${barcode}. Updating inventory...`);
  scanInFlight = true;
  lastSubmittedBarcode = barcode;
  lastSubmittedAt = now;

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
      flash(el.lastScanPanel, "scan-warning");
    } else {
      renderUnknownScan("");
      setStatus(`${barcode} updated inventory immediately.`, "ok");
      flash(el.inventoryPanel, "inventory-updated");
      flash(el.lastScanPanel, "scan-success");
    }
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.lastScanPanel, "scan-warning");
  } finally {
    scanInFlight = false;
  }
}

async function addProduct(event) {
  event.preventDefault();

  const barcode = normalizeScan(el.productBarcode.value);
  const name = el.productName.value.trim();
  const quantity = Number(el.productQuantity.value);

  if (!barcode || !name || !Number.isFinite(quantity) || quantity < 0) {
    setStatus("Enter a product name, barcode, and quantity.", "warn");
    flash(el.addProductPanel, "scan-warning");
    return;
  }

  el.addProductButton.disabled = true;
  setStatus(`Adding ${name}...`);

  try {
    const data = await api("/api/products", {
      method: "POST",
      body: JSON.stringify({ barcode, name, quantity }),
    });
    renderInventory(data.inventory);
    renderLog(data.activity);
    renderUnknownScan("");
    el.productForm.reset();
    el.productQuantity.value = "5";
    el.productName.focus();
    setStatus(`${name} is ready to scan.`, "ok");
    flash(el.addProductPanel, "scan-success");
    flash(el.inventoryPanel, "inventory-updated");
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.addProductPanel, "scan-warning");
  } finally {
    el.addProductButton.disabled = false;
  }
}

async function resetDemo() {
  const data = await api("/api/reset", { method: "POST" });
  previousInventory = new Map();
  renderInventory(data.inventory);
  renderLog(data.activity);
  renderUnknownScan("");
  setStatus("Demo reset.", "ok");
  el.productName.focus();
}

function useUnknownBarcode() {
  const barcode = el.unknownCode.textContent.trim();
  if (!barcode) return;

  el.productBarcode.value = barcode;
  el.productName.focus();
  setStatus("Unknown barcode copied into the product form. Add a name and quantity.", "ok");
  flash(el.addProductPanel, "scan-success");
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
el.resetButton.addEventListener("click", resetDemo);
el.useUnknownButton.addEventListener("click", useUnknownBarcode);

showServerNotice();

loadState()
  .then(() => {
    const barcodeFromUrl = getBarcodeFromPageUrl();
    if (barcodeFromUrl) {
      scanProduct(barcodeFromUrl);
      return;
    }
    el.productName.focus();
  })
  .catch((error) => setStatus(error.message, "warn"));
