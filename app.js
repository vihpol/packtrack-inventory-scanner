const el = {
  productForm: document.querySelector("#productForm"),
  productBarcode: document.querySelector("#productBarcode"),
  productDescription: document.querySelector("#productDescription"),
  productQuantity: document.querySelector("#productQuantity"),
  labelPhotoInput: document.querySelector("#labelPhotoInput"),
  analyzeLabelButton: document.querySelector("#analyzeLabelButton"),
  labelAnalysisStatus: document.querySelector("#labelAnalysisStatus"),
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
  phoneScannerLink: document.querySelector("#phoneScannerLink"),
  copyScannerLinkButton: document.querySelector("#copyScannerLinkButton"),
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
  hardwareScanInput: document.querySelector("#hardwareScanInput"),
  phoneHardwareInput: document.querySelector("#phoneHardwareInput"),
  phoneModeButtons: Array.from(document.querySelectorAll("[data-scan-mode]")),
  phoneCameraReader: document.querySelector("#phoneCameraReader"),
  scannerOverlay: document.querySelector("#scannerOverlay"),
  phoneScanResult: document.querySelector("#phoneScanResult"),
};

let previousInventory = new Map();
let phoneScanner = null;
let phoneScanMode = "smart";
let scanLocked = false;
let latestActivityId = "";
let dashboardAlertTimer = null;
let dashboardPollTimer = null;
let scanAudioContext = null;
let hardwareScanBuffer = "";
let hardwareScanBufferTimer = null;
let selectedLabelPhoto = null;

const dashboardViews = {
  inventory: {
    title: "Stock on hand",
    description: "Current equipment count.",
  },
  history: {
    title: "Scan history",
    description: "Incoming and outgoing activity.",
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
    smart: "Stock",
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
  renderScanList(el.incomingLog, data.incoming || [], "No incoming activity");
  renderScanList(el.outgoingLog, data.outgoing || [], "No outgoing activity");
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
        <td colspan="4">No stock records</td>
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
          <td>${escapeHtml(item.description || item.name || "Unassigned item")}</td>
          <td class="${changed ? "changed" : ""}">${item.quantity}</td>
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

async function loadNetworkInfo() {
  if (isPhoneScannerView()) return;

  try {
    const info = await api("/api/network");
    el.phoneScannerLink.href = info.scannerUrl;
    el.phoneScannerLink.textContent = info.scannerUrl;
  } catch (error) {
    el.phoneScannerLink.textContent = "Scanner link unavailable";
  }
}

async function scanProduct({ barcode, mode = "smart", description = "", cost = 0, quantity = 1 }) {
  const normalized = normalizeScan(barcode);
  if (!normalized) return;

  setStatus(`${normalized} scanned`);

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

async function togglePhoneCamera() {
  if (phoneScanner) {
    await stopPhoneCamera();
    return;
  }

  primeScanAudio();

  if (!window.isSecureContext || !navigator.mediaDevices) {
    setStatus("Camera needs HTTPS. Open the localtunnel HTTPS URL on your phone.", "warn");
    return;
  }

  if (!window.Html5Qrcode) {
    setStatus("Scanner loading. Try again.", "warn");
    return;
  }

  try {
    phoneScanner = new Html5Qrcode("phoneCameraReader", {
      formatsToSupport: getSupportedPhoneFormats(),
      useBarCodeDetectorIfSupported: true,
    });
    el.phoneCameraButton.textContent = "Stop camera";
    el.scannerOverlay.hidden = false;
    scanLocked = false;
    setStatus("Scanner active");

    await phoneScanner.start(
      { facingMode: "environment" },
      {
        fps: 12,
        aspectRatio: 1.333,
      },
      async (decodedText) => {
        if (scanLocked) return;
        scanLocked = true;

        const normalized = normalizeScan(decodedText);
        setStatus(`${normalized} detected`);

        try {
          const result = await scanProduct({
            barcode: decodedText,
            mode: phoneScanMode,
            quantity: 1,
          });
          if (result && result.matched === false) {
            playScanPing("warn");
            if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
            setStatus(`${normalized} not found`, "warn");
          } else {
            playScanPing("ok");
            if (navigator.vibrate) navigator.vibrate(160);
            setStatus(`${normalized} saved`, "ok");
          }
        } catch (error) {
          playScanPing("warn");
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
    setStatus("Camera access unavailable", "warn");
  }
}

function scanModeLabel(mode) {
  if (mode === "incoming") return "receiving";
  if (mode === "outgoing") return "issue";
  return "stock";
}

async function stopPhoneCamera(options = {}) {
  if (!phoneScanner) return;
  await phoneScanner.stop().catch(() => {});
  phoneScanner.clear();
  phoneScanner = null;
  el.phoneCameraButton.textContent = "Start camera";
  el.scannerOverlay.hidden = true;
  if (!options.silent) setStatus("Scanner stopped");
}

function getSupportedPhoneFormats() {
  if (!window.Html5QrcodeSupportedFormats) return undefined;

  return [
    Html5QrcodeSupportedFormats.AZTEC,
    Html5QrcodeSupportedFormats.CODABAR,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.DATA_MATRIX,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.MAXICODE,
    Html5QrcodeSupportedFormats.PDF_417,
    Html5QrcodeSupportedFormats.QR_CODE,
    Html5QrcodeSupportedFormats.RSS_14,
    Html5QrcodeSupportedFormats.RSS_EXPANDED,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.UPC_EAN_EXTENSION,
  ].filter(Boolean);
}

async function addProduct(event) {
  event.preventDefault();

  const barcode = normalizeScan(el.productBarcode.value);
  const description = el.productDescription.value.trim();
  const cost = 0;
  const quantity = Number(el.productQuantity.value);

  if (!barcode || !description || !Number.isFinite(quantity) || quantity < 0) {
    setStatus("SKU, item, and units are required", "warn");
    flash(el.inventoryPanel, "scan-warning");
    return;
  }

  el.addProductButton.disabled = true;
  setStatus(`Saving ${description}`);

  try {
    const data = await api("/api/products", {
      method: "POST",
      body: JSON.stringify({ barcode, description, cost, quantity }),
    });
    renderState(data);
    el.productForm.reset();
    el.productQuantity.value = "1";
    closeEntryModal();
    setStatus(`${description} saved`, "ok");
    flash(el.inventoryPanel, "scan-success");
  } catch (error) {
    setStatus(error.message, "warn");
    flash(el.inventoryPanel, "scan-warning");
  } finally {
    el.addProductButton.disabled = false;
  }
}

function setLabelAnalysisStatus(message, tone = "") {
  if (!el.labelAnalysisStatus) return;
  el.labelAnalysisStatus.textContent = message;
  el.labelAnalysisStatus.className = tone;
}

function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const reader = new FileReader();

    reader.onload = () => {
      image.onload = () => {
        const maxSide = 3200;
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

function handleLabelPhotoSelected() {
  selectedLabelPhoto = el.labelPhotoInput.files && el.labelPhotoInput.files[0];
  el.analyzeLabelButton.disabled = !selectedLabelPhoto;
  setLabelAnalysisStatus(selectedLabelPhoto ? selectedLabelPhoto.name : "Optional: take a photo to prefill this entry.");
  if (selectedLabelPhoto) {
    analyzeLabelPhoto();
  }
}

async function analyzeLabelPhoto() {
  if (!selectedLabelPhoto) {
    setLabelAnalysisStatus("Choose a label photo first.", "warn");
    return;
  }

  el.analyzeLabelButton.disabled = true;
  setLabelAnalysisStatus("Analyzing label...");

  try {
    const image = await imageFileToDataUrl(selectedLabelPhoto);
    const analysis = await api("/api/analyze-label", {
      method: "POST",
      body: JSON.stringify({ image }),
      timeout: 45000,
    });

    if (analysis.barcode) el.productBarcode.value = analysis.barcode;
    if (analysis.description) el.productDescription.value = analysis.description;
    if (analysis.quantity) el.productQuantity.value = analysis.quantity;

    const confidence = analysis.confidence ? ` ${analysis.confidence}.` : "";
    setLabelAnalysisStatus(`Prefilled from photo.${confidence}`, "ok");
    setStatus("Label details filled", "ok");
  } catch (error) {
    setLabelAnalysisStatus(error.message, "warn");
    setStatus(error.message, "warn");
  } finally {
    el.analyzeLabelButton.disabled = !selectedLabelPhoto;
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

async function copyScannerLink() {
  const scannerUrl = el.phoneScannerLink.href;
  try {
    await navigator.clipboard.writeText(scannerUrl);
    setStatus("Scanner link copied", "ok");
  } catch (error) {
    setStatus("Copy failed. Select the link manually.", "warn");
  }
}

function openEntryModal() {
  el.entryModal.hidden = false;
  el.productBarcode.focus();
}

function closeEntryModal() {
  el.entryModal.hidden = true;
  focusHardwareScanner();
}

function handleInventoryClick(event) {
  const deleteButton = event.target.closest("[data-delete-barcode]");
  if (!deleteButton) return;
  deleteProduct(deleteButton.dataset.deleteBarcode);
}

function hardwareScannerInput() {
  return isPhoneScannerView() ? el.phoneHardwareInput : el.hardwareScanInput;
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

  const mode = event.currentTarget === el.phoneHardwareInput ? phoneScanMode : "smart";
  submitHardwareScan(event.currentTarget, mode);
}

function shouldCaptureHardwareKey(event) {
  if (isFileMode() || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!isPhoneScannerView() && !el.entryModal.hidden) return false;
  const target = event.target;
  if (target === el.hardwareScanInput || target === el.phoneHardwareInput) return false;
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
      mode: isPhoneScannerView() ? phoneScanMode : "smart",
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
el.labelPhotoInput.addEventListener("change", handleLabelPhotoSelected);
el.analyzeLabelButton.addEventListener("click", analyzeLabelPhoto);
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
el.copyScannerLinkButton.addEventListener("click", copyScannerLink);
el.phoneCameraButton.addEventListener("click", togglePhoneCamera);
if (el.hardwareScanInput) {
  el.hardwareScanInput.addEventListener("keydown", handleHardwareScannerKeydown);
}
if (el.phoneHardwareInput) {
  el.phoneHardwareInput.addEventListener("keydown", handleHardwareScannerKeydown);
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
loadNetworkInfo();

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

loadState({ silent: true })
  .then(() => {
    if (isPhoneScannerView()) {
      setPhoneScanMode("smart");
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
