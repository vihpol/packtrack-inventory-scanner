const el = {
  productForm: document.querySelector("#productForm"),
  productBarcode: document.querySelector("#productBarcode"),
  productDescription: document.querySelector("#productDescription"),
  productLabelType: document.querySelector("#productLabelType"),
  productPackageId: document.querySelector("#productPackageId"),
  productDpn: document.querySelector("#productDpn"),
  productModelRef: document.querySelector("#productModelRef"),
  productOrigin: document.querySelector("#productOrigin"),
  productQuantity: document.querySelector("#productQuantity"),
  addProductButton: document.querySelector("#addProductButton"),
  openEntryModalButton: document.querySelector("#openEntryModalButton"),
  closeEntryModalButton: document.querySelector("#closeEntryModalButton"),
  cancelEntryModalButton: document.querySelector("#cancelEntryModalButton"),
  entryModal: document.querySelector("#entryModal"),
  dashboardAlert: document.querySelector("#dashboardAlert"),
  dashboardAlertMessage: document.querySelector("#dashboardAlertMessage"),
  closeDashboardAlertButton: document.querySelector("#closeDashboardAlertButton"),
  totalSkus: document.querySelector("#totalSkus"),
  totalUnits: document.querySelector("#totalUnits"),
  receivedToday: document.querySelector("#receivedToday"),
  issuedToday: document.querySelector("#issuedToday"),
  lastScanStrip: document.querySelector("#lastScanStrip"),
  lastScanText: document.querySelector("#lastScanText"),
  loadDemoButton: document.querySelector("#loadDemoButton"),
  resetDemoButton: document.querySelector("#resetDemoButton"),
  status: document.querySelector("#status"),
  inventoryBody: document.querySelector("#inventoryBody"),
  incomingLog: document.querySelector("#incomingLog"),
  outgoingLog: document.querySelector("#outgoingLog"),
  inventoryPanel: document.querySelector("#inventoryPanel"),
  historyPanel: document.querySelector("#historyPanel"),
  hardwareScanCard: document.querySelector(".hardware-scan-card"),
  dashboardShell: document.querySelector("#dashboardShell"),
  hero: document.querySelector(".hero"),
  dashboardView: document.querySelector("#dashboardView"),
  workbookTitle: document.querySelector("#workbookTitle"),
  workbookDescription: document.querySelector("#workbookDescription"),
  scannerLaunchLink: document.querySelector("#scannerLaunchLink"),
  navButtons: Array.from(document.querySelectorAll("[data-view]")),
  viewPanels: Array.from(document.querySelectorAll("[data-view-panel]")),
  phoneScanner: document.querySelector("#phoneScanner"),
  hardwareScanInput: document.querySelector("#hardwareScanInput"),
  phoneModeButtons: Array.from(document.querySelectorAll("[data-scan-mode]")),
  phoneScanResult: document.querySelector("#phoneScanResult"),
};

let previousInventory = new Map();
let inventoryByBarcode = new Map();
let editingBarcode = "";
let phoneScanMode = "incoming";
let latestActivityId = "";
let dashboardAlertTimer = null;
let dashboardPollTimer = null;
let scanAudioContext = null;
let hardwareScanBuffer = "";
let hardwareScanBufferTimer = null;

const dashboardViews = {
  inventory: {
    title: "Stock on hand",
    description: "Current equipment count.",
  },
  history: {
    title: "Scanned products",
    description: "Each scan creates a row with the barcode, product description, and unit change.",
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
  if (el.hardwareScanCard) {
    el.hardwareScanCard.hidden = selected === "history";
  }

  if (!isPhoneScannerView() && window.location.hash !== `#${selected}`) {
    history.replaceState(null, "", `#${selected}`);
  }
}

function setPhoneScanMode(mode) {
  phoneScanMode = ["incoming", "outgoing"].includes(mode) ? mode : "incoming";
  el.phoneModeButtons.forEach((button) => {
    const active = button.dataset.scanMode === phoneScanMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  const modeLabel = {
    incoming: "Receive",
    outgoing: "Issue",
  }[phoneScanMode];
  setStatus(`${modeLabel} mode selected`);
}

function primeScanAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  if (!scanAudioContext) {
    scanAudioContext = new AudioContext();
  }
  if (scanAudioContext.state === "suspended") {
    scanAudioContext.resume().catch(() => {});
  }
}

function playScanPing(tone = "ok") {
  if (!isPhoneScannerView()) return;
  primeScanAudio();
  if (!scanAudioContext) return;

  const now = scanAudioContext.currentTime;
  const oscillator = scanAudioContext.createOscillator();
  const gain = scanAudioContext.createGain();
  const isWarning = tone === "warn";
  const frequency = isWarning ? 260 : 150;

  oscillator.type = isWarning ? "sine" : "sawtooth";
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(isWarning ? 180 : 92, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(isWarning ? 0.18 : 0.11, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (isWarning ? 0.18 : 0.26));
  oscillator.connect(gain);
  gain.connect(scanAudioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + (isWarning ? 0.2 : 0.28));
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
  const mode = String(params.get("mode") || params.get("action") || "incoming").toLowerCase();
  return ["outgoing", "out"].includes(mode) ? "outgoing" : "incoming";
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

  const timeoutMs = options.timeout || 6000;
  const requestOptions = { ...options };
  delete requestOptions.timeout;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    ...requestOptions,
  }).catch((error) => {
    if (error.name === "AbortError") {
      throw new Error("Inventory update timed out. Check Wi-Fi, then scan again.");
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

function isToday(value) {
  if (!value) return false;
  const date = new Date(value);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function timeOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
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
  renderScanList(el.incomingLog, data.incoming || [], "No received scans yet");
  renderScanList(el.outgoingLog, data.outgoing || [], "No issued scans yet");
  renderMetrics(data);
  renderLastScan(data);
}

function renderMetrics(data) {
  const inventory = data.inventory || [];
  const incoming = data.incoming || [];
  const outgoing = data.outgoing || [];

  el.totalSkus.textContent = inventory.length;
  el.totalUnits.textContent = inventory.reduce((total, item) => total + Number(item.quantity || 0), 0);
  el.receivedToday.textContent = incoming
    .filter((entry) => isToday(entry.time))
    .reduce((total, entry) => total + Number(entry.quantity || 0), 0);
  el.issuedToday.textContent = outgoing
    .filter((entry) => isToday(entry.time))
    .reduce((total, entry) => total + Number(entry.quantity || 0), 0);
}

function renderLastScan(data) {
  const incoming = (data.incoming || []).map((entry) => ({ ...entry, direction: "received" }));
  const outgoing = (data.outgoing || []).map((entry) => ({ ...entry, direction: "issued" }));
  const latest = incoming
    .concat(outgoing)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())[0];

  if (!latest) {
    el.lastScanStrip.className = "last-scan-strip idle";
    el.lastScanText.textContent = "No scans yet";
    return;
  }

  const isReceived = latest.direction === "received";
  const verb = isReceived ? "RECEIVED" : "ISSUED";
  const delta = `${isReceived ? "+" : "-"}${latest.quantity || 1} unit${Number(latest.quantity || 1) === 1 ? "" : "s"}`;
  el.lastScanStrip.className = `last-scan-strip ${latest.direction}`;
  el.lastScanText.textContent = `${verb} • ${latest.barcode} • ${delta} • ${timeOnly(latest.time)}`;
}

function showDashboardAlert(message) {
  if (isPhoneScannerView()) return;

  window.clearTimeout(dashboardAlertTimer);
  el.dashboardAlertMessage.textContent = message;
  el.dashboardAlert.hidden = false;
  dashboardAlertTimer = window.setTimeout(closeDashboardAlert, 9000);
}

function closeDashboardAlert() {
  window.clearTimeout(dashboardAlertTimer);
  el.dashboardAlert.hidden = true;
}

function processDashboardActivity(activity, options = {}) {
  if (isPhoneScannerView() || !Array.isArray(activity) || activity.length === 0) return;

  const latest = activity[0];
  if (!latestActivityId) {
    latestActivityId = latest.id;
    return;
  }
  if (!latest.id || latest.id === latestActivityId) return;

  latestActivityId = latest.id;
  if (options.silent) return;

  if (["Incoming inventory", "Outgoing inventory", "Units removed", "Product added"].includes(latest.type)) {
    setDashboardView("inventory");
  }

  if (latest.type === "Unknown outgoing scan") {
    showDashboardAlert(`${latest.details}. Item was not issued.`);
  } else if (latest.type === "Rejected outgoing scan") {
    showDashboardAlert(latest.details);
  }
}

function renderInventory(items) {
  if (items.length === 0) {
    el.inventoryBody.innerHTML = `
      <tr>
        <td colspan="7">No stock records</td>
      </tr>
    `;
    previousInventory = new Map();
    inventoryByBarcode = new Map();
    return;
  }

  el.inventoryBody.innerHTML = items
    .map((item) => {
      const previous = previousInventory.get(item.barcode);
      const changed = previous !== undefined && previous !== item.quantity;
      return `
        <tr>
          <td>${renderField(item.labelType || item.description || item.name, item, "labelType")}</td>
          <td>
            <code>${escapeHtml(item.packageId || item.barcode)}</code>${renderEstimatedBadge(item, item.packageId ? "packageId" : "barcode")}
            ${item.barcodePrefix ? `<span class="cell-note">Prefix ${escapeHtml(item.barcodePrefix)}</span>` : ""}
          </td>
          <td>${renderField(item.dpn, item, "dpn")}</td>
          <td>${renderField(item.modelRef, item, "modelRef")}</td>
          <td>${renderField(item.origin, item, "origin")}</td>
          <td class="${changed ? "changed" : ""}">${item.quantity}</td>
          <td>
            <div class="row-actions">
              <button class="unit-button" type="button" data-edit-barcode="${escapeHtml(item.barcode)}">Edit</button>
              <button class="unit-button" type="button" data-remove-units-barcode="${escapeHtml(item.barcode)}" data-current-units="${item.quantity}">Remove units</button>
              <button class="delete-button" type="button" data-delete-barcode="${escapeHtml(item.barcode)}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  previousInventory = new Map(items.map((item) => [item.barcode, item.quantity]));
  inventoryByBarcode = new Map(items.map((item) => [item.barcode, item]));
}

function displayField(value) {
  return String(value || "").trim() || "-";
}

function estimatedFields(item) {
  return Array.isArray(item.estimatedFields) ? item.estimatedFields : [];
}

function isEstimated(item, field) {
  return estimatedFields(item).includes(field);
}

function renderEstimatedBadge(item, field) {
  return isEstimated(item, field) ? `<span class="estimate-badge" title="Estimated from the label photo. Verify before final use.">Estimated</span>` : "";
}

function renderField(value, item, field) {
  return `${escapeHtml(displayField(value))}${renderEstimatedBadge(item, field)}`;
}

function renderScanList(container, entries, emptyText) {
  const visible = entries;
  if (visible.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="4">${emptyText}</td>
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
          <td>${escapeHtml(entry.description || "Unassigned item")}</td>
          <td>${entry.quantity}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadState(options = {}) {
  try {
    const data = await api("/api/state");
    renderState(data);
    processDashboardActivity(data.activity, options);
    return data;
  } catch (error) {
    throw error;
  }
}

async function loadScannerLink() {
  if (!el.scannerLaunchLink || isPhoneScannerView() || isFileMode()) return;

  try {
    const network = await api("/api/network");
    if (network.scannerUrl) {
      el.scannerLaunchLink.href = network.scannerUrl;
      el.scannerLaunchLink.title = network.scannerUrl;
    }
  } catch (error) {
    el.scannerLaunchLink.href = "/scanner";
  }
}

async function scanProduct({
  barcode,
  mode = "smart",
  description = "",
  cost = 0,
  quantity = 1,
  labelType = "",
  packageId = "",
  barcodePrefix = "",
  dpn = "",
  modelRef = "",
  origin = "",
  estimatedFields = [],
}) {
  const normalized = normalizeScan(barcode);
  if (!normalized) return;

  setStatus(`${normalized} scanned`);

  try {
    const result = await api("/api/scan-product", {
      method: "POST",
      timeout: 20000,
      body: JSON.stringify({
        barcode: normalized,
        mode,
        description,
        cost,
        quantity,
        labelType,
        packageId,
        barcodePrefix,
        dpn,
        modelRef,
        origin,
        estimatedFields,
      }),
    });

    renderState(result);
    if (result.mode === "incoming") {
      setStatus(`${normalized} received`, "ok");
      flash(el.historyPanel, "scan-success");
      flash(el.inventoryPanel, "inventory-updated");
    } else if (result.matched === false) {
      setStatus(`${normalized} not found in stock`, "warn");
      showDashboardAlert(`${normalized} is not in stock. Item was not issued.`);
      flash(el.historyPanel, "scan-warning");
    } else {
      setStatus(`${normalized} issued`, "ok");
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

async function addProduct(event) {
  event.preventDefault();

  const barcode = normalizeScan(el.productBarcode.value);
  const description = el.productDescription.value.trim();
  const cost = 0;
  const quantity = Number(el.productQuantity.value);
  const payload = {
    barcode,
    description,
    cost,
    quantity,
    labelType: el.productLabelType.value.trim(),
    packageId: el.productPackageId.value.trim(),
    dpn: el.productDpn.value.trim(),
    modelRef: el.productModelRef.value.trim(),
    origin: el.productOrigin.value.trim(),
    estimatedFields: [],
  };

  if (!barcode || !description || !Number.isFinite(quantity) || quantity < 0) {
    setStatus("SKU, item, and units are required", "warn");
    flash(el.inventoryPanel, "scan-warning");
    return;
  }

  el.addProductButton.disabled = true;
  setStatus(`Saving ${description}`);

  try {
    const wasEditing = Boolean(editingBarcode);
    const path = editingBarcode ? `/api/products/${encodeURIComponent(editingBarcode)}` : "/api/products";
    const data = await api(path, {
      method: editingBarcode ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    renderState(data);
    resetEntryModal();
    closeEntryModal();
    setStatus(`${description} ${wasEditing ? "updated" : "saved"}`, "ok");
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
    setStatus(`${normalized} deleted`, "ok");
    flash(el.inventoryPanel, "scan-success");
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.inventoryPanel, "scan-warning");
  }
}

async function removeUnits(barcode, currentUnits) {
  const normalized = normalizeScan(barcode);
  const available = Number(currentUnits || 0);
  if (!normalized || available <= 0) {
    setStatus("No units available to remove", "warn");
    flash(el.inventoryPanel, "scan-warning");
    return;
  }

  const entered = window.prompt(`Remove how many units from ${normalized}?`, "1");
  if (entered === null) return;

  const quantity = Math.round(Number(entered));
  if (!Number.isFinite(quantity) || quantity < 1) {
    setStatus("Enter a unit count of 1 or higher", "warn");
    flash(el.inventoryPanel, "scan-warning");
    return;
  }
  if (quantity > available) {
    setStatus(`Only ${available} unit${available === 1 ? "" : "s"} available`, "warn");
    flash(el.inventoryPanel, "scan-warning");
    return;
  }

  try {
    const data = await api(`/api/products/${encodeURIComponent(normalized)}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity }),
    });
    renderState(data);
    setStatus(`${quantity} unit${quantity === 1 ? "" : "s"} removed`, "ok");
    flash(el.inventoryPanel, "inventory-updated");
    flash(el.historyPanel, "scan-success");
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.inventoryPanel, "scan-warning");
  }
}

async function loadDemoData() {
  try {
    const data = await api("/api/demo", { method: "POST" });
    renderState(data);
    processDashboardActivity(data.activity, { silent: true });
    setStatus("Demo data loaded", "ok");
    flash(el.inventoryPanel, "scan-success");
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

async function resetInventory() {
  try {
    const data = await api("/api/reset", { method: "POST" });
    previousInventory = new Map();
    renderState(data);
    processDashboardActivity(data.activity, { silent: true });
    setStatus("Inventory reset", "ok");
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

function openEntryModal() {
  editingBarcode = "";
  el.productForm.reset();
  el.productQuantity.value = "1";
  document.querySelector("#entryModalTitle").textContent = "New stock item";
  el.addProductButton.textContent = "Save item";
  el.entryModal.hidden = false;
  el.productBarcode.focus();
}

function closeEntryModal() {
  el.entryModal.hidden = true;
  focusHardwareScanner();
}

function resetEntryModal() {
  editingBarcode = "";
  el.productForm.reset();
  el.productQuantity.value = "1";
  document.querySelector("#entryModalTitle").textContent = "New stock item";
  el.addProductButton.textContent = "Save item";
}

function openEditModal(barcode) {
  const item = inventoryByBarcode.get(barcode);
  if (!item) return;

  editingBarcode = item.barcode;
  document.querySelector("#entryModalTitle").textContent = "Edit stock item";
  el.addProductButton.textContent = "Save changes";
  el.productBarcode.value = item.barcode || "";
  el.productDescription.value = item.description || item.labelType || "";
  el.productLabelType.value = item.labelType || "";
  el.productPackageId.value = item.packageId || "";
  el.productDpn.value = item.dpn || "";
  el.productModelRef.value = item.modelRef || "";
  el.productOrigin.value = item.origin || "";
  el.productQuantity.value = Number(item.quantity || 0);
  el.entryModal.hidden = false;
  el.productDescription.focus();
}

function handleInventoryClick(event) {
  const editButton = event.target.closest("[data-edit-barcode]");
  if (editButton) {
    openEditModal(editButton.dataset.editBarcode);
    return;
  }

  const unitButton = event.target.closest("[data-remove-units-barcode]");
  if (unitButton) {
    removeUnits(unitButton.dataset.removeUnitsBarcode, unitButton.dataset.currentUnits);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-barcode]");
  if (!deleteButton) return;
  deleteProduct(deleteButton.dataset.deleteBarcode);
}

function hardwareScannerInput() {
  return isPhoneScannerView() ? null : el.hardwareScanInput;
}

function focusHardwareScanner() {
  const input = hardwareScannerInput();
  if (!input || isFileMode()) return;
  if (!isPhoneScannerView() && !el.entryModal.hidden) return;
  window.setTimeout(() => input.focus(), 40);
}

async function submitHardwareScan(input, mode) {
  const barcode = normalizeScan(input.value);
  input.value = "";
  if (!barcode) return;

  try {
    await scanProduct({
      barcode,
      mode,
      quantity: 1,
    });
    focusHardwareScanner();
  } catch (error) {
    focusHardwareScanner();
  }
}

function handleHardwareScannerKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();

  submitHardwareScan(event.currentTarget, "smart");
}

function shouldCaptureHardwareKey(event) {
  if (isFileMode() || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isPhoneScannerView()) return false;
  if (!isPhoneScannerView() && !el.entryModal.hidden) return false;
  const target = event.target;
  if (target === el.hardwareScanInput) return false;
  if (target && target.closest && target.closest("input, textarea, select, [contenteditable='true']")) return false;
  return true;
}

function resetHardwareScanBuffer() {
  hardwareScanBuffer = "";
  if (hardwareScanBufferTimer) {
    window.clearTimeout(hardwareScanBufferTimer);
    hardwareScanBufferTimer = null;
  }
}

function handleGlobalHardwareScannerKeydown(event) {
  if (!shouldCaptureHardwareKey(event)) return;

  if (event.key === "Enter" || event.key === "Tab") {
    const barcode = normalizeScan(hardwareScanBuffer);
    resetHardwareScanBuffer();
    if (barcode.length < 3) return;
    event.preventDefault();
    scanProduct({
      barcode,
      mode: "smart",
      quantity: 1,
    }).catch(() => {});
    return;
  }

  if (event.key.length !== 1) return;

  hardwareScanBuffer += event.key;
  if (hardwareScanBufferTimer) window.clearTimeout(hardwareScanBufferTimer);
  hardwareScanBufferTimer = window.setTimeout(resetHardwareScanBuffer, 180);
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
el.closeDashboardAlertButton.addEventListener("click", closeDashboardAlert);
el.loadDemoButton.addEventListener("click", loadDemoData);
el.resetDemoButton.addEventListener("click", resetInventory);
if (el.hardwareScanInput) {
  el.hardwareScanInput.addEventListener("keydown", handleHardwareScannerKeydown);
}
el.phoneModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    primeScanAudio();
    setPhoneScanMode(button.dataset.scanMode);
    focusHardwareScanner();
  });
});
el.navButtons.forEach((button) => {
  button.addEventListener("click", () => setDashboardView(button.dataset.view));
});
document.addEventListener("click", (event) => {
  if (event.target.closest("button, a, input, textarea, select, label")) return;
  focusHardwareScanner();
});
document.addEventListener("keydown", handleGlobalHardwareScannerKeydown);

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
  loadScannerLink();
}

loadState({ silent: true })
  .then(() => {
    if (isPhoneScannerView()) {
      setPhoneScanMode(getScanModeFromUrl());
      focusHardwareScanner();
      return;
    }
    dashboardPollTimer = window.setInterval(() => {
      loadState().catch((error) => setStatus(error.message, "warn"));
    }, 1200);
    const barcodeFromUrl = getBarcodeFromPageUrl();
    if (barcodeFromUrl) {
      scanProduct({
        barcode: barcodeFromUrl,
        mode: getScanModeFromUrl(),
        quantity: 1,
      });
      return;
    }
    focusHardwareScanner();
  })
  .catch((error) => setStatus(error.message, "warn"));
