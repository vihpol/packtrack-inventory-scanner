const el = {
  productForm: document.querySelector("#productForm"),
  productBarcode: document.querySelector("#productBarcode"),
  productDescription: document.querySelector("#productDescription"),
  productCost: document.querySelector("#productCost"),
  productQuantity: document.querySelector("#productQuantity"),
  addProductButton: document.querySelector("#addProductButton"),
  openEntryModalButton: document.querySelector("#openEntryModalButton"),
  closeEntryModalButton: document.querySelector("#closeEntryModalButton"),
  cancelEntryModalButton: document.querySelector("#cancelEntryModalButton"),
  entryModal: document.querySelector("#entryModal"),
  status: document.querySelector("#status"),
  inventoryBody: document.querySelector("#inventoryBody"),
  incomingLog: document.querySelector("#incomingLog"),
  outgoingLog: document.querySelector("#outgoingLog"),
  inventoryPanel: document.querySelector("#inventoryPanel"),
  historyPanel: document.querySelector("#historyPanel"),
  dashboardShell: document.querySelector("#dashboardShell"),
  hero: document.querySelector(".hero"),
  dashboardView: document.querySelector("#dashboardView"),
  workbookTitle: document.querySelector("#workbookTitle"),
  workbookDescription: document.querySelector("#workbookDescription"),
  navButtons: Array.from(document.querySelectorAll("[data-view]")),
  viewPanels: Array.from(document.querySelectorAll("[data-view-panel]")),
  phoneScanner: document.querySelector("#phoneScanner"),
  phoneCameraButton: document.querySelector("#phoneCameraButton"),
  phoneModeButtons: Array.from(document.querySelectorAll("[data-scan-mode]")),
  phoneCameraReader: document.querySelector("#phoneCameraReader"),
  scannerOverlay: document.querySelector("#scannerOverlay"),
  phoneScanResult: document.querySelector("#phoneScanResult"),
};

let previousInventory = new Map();
let phoneScanner = null;
let phoneScanMode = "smart";
let scanLocked = false;

const dashboardViews = {
  inventory: {
    title: "Active inventory",
    description: "Network hardware currently available in stock.",
  },
  history: {
    title: "History",
    description: "Incoming and outgoing scan logs shown side by side.",
  },
};

function isPhoneScannerView() {
  return window.location.pathname === "/scanner";
}

function isFileMode() {
  return window.location.protocol === "file:";
}

function showServerNotice() {
  if (!isFileMode()) return;
  setStatus("This page was opened as a file. Open http://localhost:5173 so scans can update inventory.", "warn");
}

function setDashboardView(view) {
  const selected = dashboardViews[view] ? view : "inventory";

  el.viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== selected;
  });

  el.navButtons.forEach((button) => {
    const isActive = button.dataset.view === selected;
    button.classList.toggle("active", isActive);
    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  el.workbookTitle.textContent = dashboardViews[selected].title;
  el.workbookDescription.textContent = dashboardViews[selected].description;

  if (!isPhoneScannerView() && window.location.hash !== `#${selected}`) {
    history.replaceState(null, "", `#${selected}`);
  }
}

function setPhoneScanMode(mode) {
  phoneScanMode = ["smart", "incoming", "outgoing"].includes(mode) ? mode : "smart";
  el.phoneModeButtons.forEach((button) => {
    const active = button.dataset.scanMode === phoneScanMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  const modeLabel = {
    smart: "Active inventory",
    incoming: "Incoming inventory",
    outgoing: "Outgoing inventory",
  }[phoneScanMode];
  setStatus(`${modeLabel} mode selected. Tap Start camera.`);
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
  if (el.status) {
    el.status.textContent = message;
    el.status.className = `status ${tone}`;
  }
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
  if (items.length === 0) {
    el.inventoryBody.innerHTML = `
      <tr>
        <td colspan="6">No hardware stock yet. Scan an equipment label or create an entry to start.</td>
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
          <td>${escapeHtml(item.description || item.name || "Scanned hardware")}</td>
          <td>${money(item.cost)}</td>
          <td class="${changed ? "changed" : ""}">${item.quantity}</td>
          <td>${money(itemValue(item))}</td>
          <td><button class="delete-button" type="button" data-delete-barcode="${escapeHtml(item.barcode)}">Delete</button></td>
        </tr>
      `;
    })
    .join("");

  previousInventory = new Map(items.map((item) => [item.barcode, item.quantity]));
}

function renderScanList(container, entries, emptyText) {
  const visible = entries;
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
          <td>${escapeHtml(entry.description || "Scanned hardware")}</td>
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
  } catch (error) {
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
      setStatus(`${normalized} added to hardware receiving.`, "ok");
      flash(el.historyPanel, "scan-success");
      flash(el.inventoryPanel, "inventory-updated");
    } else if (result.matched === false) {
      setStatus(`${normalized} is not in hardware stock yet. Receive it first.`, "warn");
      flash(el.historyPanel, "scan-warning");
    } else {
      setStatus(`${normalized} moved to deployments and returns.`, "ok");
      flash(el.historyPanel, "scan-success");
      flash(el.inventoryPanel, "inventory-updated");
    }
    return result;
  } catch (error) {
    setStatus(error.message, "warn");
    flash(mode === "outgoing" || mode === "out" ? el.historyPanel : el.inventoryPanel, "scan-warning");
    throw error;
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
    scanLocked = false;
    setStatus("Camera is on. Point it at one barcode or QR code.");

    await phoneScanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 260, height: 220 },
        aspectRatio: 1.333,
      },
      async (decodedText) => {
        if (scanLocked) return;
        scanLocked = true;

        const normalized = normalizeScan(decodedText);
        setStatus(`Read ${normalized}. Updating ${scanModeLabel(phoneScanMode)}...`);

        try {
          await scanProduct({
            barcode: decodedText,
            mode: phoneScanMode,
            description: `Scanned network hardware ${normalized}`,
            quantity: 1,
          });
          if (navigator.vibrate) navigator.vibrate(160);
          setStatus(`Scanned ${normalized}. Camera stopped so it will not scan twice.`, "ok");
        } catch (error) {
          if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
          setStatus(error.message, "warn");
        } finally {
          await stopPhoneCamera({ silent: true });
          scanLocked = false;
        }
      }
    );
  } catch (error) {
    phoneScanner = null;
    el.phoneCameraButton.textContent = "Start camera";
    el.scannerOverlay.hidden = true;
    setStatus("Camera permission was blocked or unavailable.", "warn");
  }
}

function scanModeLabel(mode) {
  if (mode === "incoming") return "incoming inventory";
  if (mode === "outgoing") return "outgoing inventory";
  return "active inventory";
}

async function stopPhoneCamera(options = {}) {
  if (!phoneScanner) return;
  await phoneScanner.stop().catch(() => {});
  phoneScanner.clear();
  phoneScanner = null;
  el.phoneCameraButton.textContent = "Start camera";
  el.scannerOverlay.hidden = true;
  if (!options.silent) setStatus("Camera stopped.");
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
    setStatus("Enter equipment label, model/configuration, cost, and units.", "warn");
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
    closeEntryModal();
    setStatus(`${description} was added to hardware stock.`, "ok");
    flash(el.inventoryPanel, "scan-success");
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.inventoryPanel, "scan-warning");
  } finally {
    el.addProductButton.disabled = false;
  }
}

async function deleteProduct(barcode) {
  const normalized = normalizeScan(barcode);
  if (!normalized) return;

  try {
    const data = await api(`/api/products/${encodeURIComponent(normalized)}`, { method: "DELETE" });
    previousInventory.delete(normalized);
    renderState(data);
    setStatus(`${normalized} was deleted.`, "ok");
    flash(el.inventoryPanel, "scan-success");
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.inventoryPanel, "scan-warning");
  }
}

function openEntryModal() {
  el.entryModal.hidden = false;
  el.productBarcode.focus();
}

function closeEntryModal() {
  el.entryModal.hidden = true;
}

function handleInventoryClick(event) {
  const deleteButton = event.target.closest("[data-delete-barcode]");
  if (!deleteButton) return;
  deleteProduct(deleteButton.dataset.deleteBarcode);
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
el.inventoryBody.addEventListener("click", handleInventoryClick);
el.openEntryModalButton.addEventListener("click", openEntryModal);
el.closeEntryModalButton.addEventListener("click", closeEntryModal);
el.cancelEntryModalButton.addEventListener("click", closeEntryModal);
el.entryModal.addEventListener("click", (event) => {
  if (event.target === el.entryModal) closeEntryModal();
});
el.phoneCameraButton.addEventListener("click", togglePhoneCamera);
el.phoneModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setPhoneScanMode(button.dataset.scanMode);
  });
});
el.navButtons.forEach((button) => {
  button.addEventListener("click", () => setDashboardView(button.dataset.view));
});

showServerNotice();

if (isPhoneScannerView()) {
  document.body.classList.add("scanner-page");
  el.dashboardShell.classList.add("scanner-only");
  el.hero.hidden = true;
  el.dashboardView.hidden = true;
  el.phoneScanner.hidden = false;
} else {
  document.body.classList.remove("scanner-page");
  el.dashboardShell.classList.remove("scanner-only");
  el.hero.hidden = false;
  el.dashboardView.hidden = false;
  el.phoneScanner.hidden = true;
  setDashboardView(window.location.hash.replace("#", ""));
}

loadState()
  .then(() => {
    if (isPhoneScannerView()) {
      setPhoneScanMode("smart");
      return;
    }
    const barcodeFromUrl = getBarcodeFromPageUrl();
    if (barcodeFromUrl) {
      scanProduct({
        barcode: barcodeFromUrl,
        mode: getScanModeFromUrl(),
        description: `Scanned network hardware ${barcodeFromUrl}`,
        quantity: 1,
      });
      return;
    }
    el.productBarcode.focus();
  })
  .catch((error) => setStatus(error.message, "warn"));
