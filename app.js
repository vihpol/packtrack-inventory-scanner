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
};

let previousInventory = new Map();

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
}

function money(value) {
  return Number(value || 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
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
        <td colspan="4">No inventory yet. Scan or create an entry to start.</td>
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
        </tr>
      `;
    })
    .join("");

  previousInventory = new Map(items.map((item) => [item.barcode, item.quantity]));
}

function renderScanList(container, entries, emptyText) {
  const visible = entries.slice(0, 8);
  if (visible.length === 0) {
    container.innerHTML = `<div class="empty-state">${emptyText}</div>`;
    return;
  }

  container.innerHTML = visible
    .map((entry) => {
      return `
        <div class="scan-entry">
          <div>
            <strong>${escapeHtml(entry.description || "Scanned product")}</strong>
            <code>${escapeHtml(entry.barcode || "")}</code>
          </div>
          <div class="entry-meta">
            <span>${money(entry.cost)}</span>
            <span>Qty ${entry.quantity}</span>
          </div>
        </div>
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

showServerNotice();

loadState()
  .then(() => {
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
