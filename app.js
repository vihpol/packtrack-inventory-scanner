const API_BASE = "/api";

let state = {
  inventory: [],
  boxes: [],
  activity: [],
  activeBoxId: "",
  operator: "",
};

let cameraStream = null;
let barcodeDetector = null;
let scanLoopActive = false;

const el = {
  navTabs: document.querySelectorAll(".nav-tab"),
  views: document.querySelectorAll(".view"),
  operatorName: document.querySelector("#operatorName"),
  boxId: document.querySelector("#boxId"),
  newBoxButton: document.querySelector("#newBoxButton"),
  scanForm: document.querySelector("#scanForm"),
  barcodeInput: document.querySelector("#barcodeInput"),
  statusMessage: document.querySelector("#statusMessage"),
  currentBoxSubtitle: document.querySelector("#currentBoxSubtitle"),
  currentBoxList: document.querySelector("#currentBoxList"),
  activeBoxMetric: document.querySelector("#activeBoxMetric"),
  itemsPackedMetric: document.querySelector("#itemsPackedMetric"),
  inventoryTable: document.querySelector("#inventoryTable"),
  boxesList: document.querySelector("#boxesList"),
  activityFeed: document.querySelector("#activityFeed"),
  sealBoxButton: document.querySelector("#sealBoxButton"),
  shipBoxButton: document.querySelector("#shipBoxButton"),
  exportButton: document.querySelector("#exportButton"),
  addItemButton: document.querySelector("#addItemButton"),
  itemDialog: document.querySelector("#itemDialog"),
  itemForm: document.querySelector("#itemForm"),
  closeItemDialogButton: document.querySelector("#closeItemDialogButton"),
  cameraButton: document.querySelector("#cameraButton"),
  cameraPreview: document.querySelector("#cameraPreview"),
  scanStage: document.querySelector(".scan-stage"),
  resetDemoButton: document.querySelector("#resetDemoButton"),
  boxQrImage: document.querySelector("#boxQrImage"),
  boxQrLink: document.querySelector("#boxQrLink"),
};

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function currentBox() {
  return state.boxes.find((box) => box.id === state.activeBoxId);
}

function makeBoxId() {
  const next = state.boxes.length + 1001;
  return `BOX-${next}`;
}

function setStatus(message, tone = "") {
  el.statusMessage.textContent = message;
  el.statusMessage.className = `status-message ${tone}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "Server request failed");
  }
  return body;
}

async function loadState(activeBoxId = state.activeBoxId) {
  state = await api("/state");

  const requestedBox = new URLSearchParams(window.location.search).get("box");
  state.activeBoxId = (activeBoxId || requestedBox || state.activeBoxId || "BOX-1001").toUpperCase();
  el.operatorName.value = state.operator || el.operatorName.value || "";
  el.boxId.value = state.activeBoxId || makeBoxId();
  render();

  if (requestedBox) {
    setStatus(`${state.activeBoxId} loaded from scanned box QR code.`, "good");
  }
}

async function createBox(id = el.boxId.value.trim() || makeBoxId()) {
  const normalized = id.toUpperCase();
  const result = await api("/boxes", {
    method: "POST",
    body: JSON.stringify({
      id: normalized,
      operator: el.operatorName.value.trim() || "Demo operator",
    }),
  });

  state = result;
  state.activeBoxId = normalized;
  el.boxId.value = normalized;
  setStatus(`${normalized} is ready for scans.`, "good");
  render();
  el.barcodeInput.focus();
}

async function addScan(barcode) {
  const code = barcode.trim();
  if (!code) return;

  const boxId = (state.activeBoxId || el.boxId.value || "BOX-1001").toUpperCase();

  try {
    const result = await api("/scan-item", {
      method: "POST",
      body: JSON.stringify({
        boxId,
        barcode: code,
        operator: el.operatorName.value.trim() || "Demo operator",
      }),
    });

    state = result;
    state.activeBoxId = boxId;
    el.boxId.value = boxId;
    el.barcodeInput.value = "";
    setStatus(`${code} added to ${boxId}. Inventory will update when the box ships.`, "good");
    render();
  } catch (error) {
    setStatus(error.message, "warn");
    if (error.message.includes("not in inventory")) {
      el.itemDialog.showModal();
      document.querySelector("#itemBarcode").value = code;
      document.querySelector("#itemName").focus();
    }
  }
}

async function sealCurrentBox() {
  const box = currentBox();
  if (!box) {
    setStatus("Create a box before sealing.", "warn");
    return;
  }

  state = await api(`/boxes/${encodeURIComponent(box.id)}/seal`, {
    method: "POST",
    body: JSON.stringify({ operator: el.operatorName.value.trim() || "Demo operator" }),
  });
  state.activeBoxId = box.id;
  setStatus(`${box.id} sealed and ready for shipment.`, "good");
  render();
}

async function shipCurrentBox() {
  const box = currentBox();
  if (!box) {
    setStatus("Scan or create a box before shipping.", "warn");
    return;
  }

  try {
    state = await api(`/boxes/${encodeURIComponent(box.id)}/ship`, {
      method: "POST",
      body: JSON.stringify({ operator: el.operatorName.value.trim() || "Demo operator" }),
    });
    state.activeBoxId = box.id;
    setStatus(`${box.id} shipped. Server inventory was updated.`, "good");
    render();
    switchView("inventory");
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

function render() {
  renderMetrics();
  renderCurrentBox();
  renderInventory();
  renderBoxes();
  renderActivity();
  renderQrPreview();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderMetrics() {
  const box = currentBox();
  const packedCount = box
    ? box.items.reduce((total, item) => total + item.quantity, 0)
    : 0;

  el.activeBoxMetric.textContent = box ? box.id : "None";
  el.itemsPackedMetric.textContent = String(packedCount);
  el.currentBoxSubtitle.textContent = box
    ? `${box.id} • ${box.status} • ${packedCount} items`
    : "Scan a box QR code or create a box.";
}

function renderCurrentBox() {
  const box = currentBox();

  if (!box || box.items.length === 0) {
    el.currentBoxList.className = "packed-list empty-state";
    el.currentBoxList.innerHTML = `<i data-lucide="package-open"></i><span>No items packed yet.</span>`;
    return;
  }

  el.currentBoxList.className = "packed-list";
  el.currentBoxList.innerHTML = box.items
    .map(
      (item) => `
      <div class="packed-item">
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <span class="meta">${escapeHtml(item.barcode)} • ${escapeHtml(item.category || "Uncategorized")}</span>
        </div>
        <span class="quantity-pill">x${item.quantity}</span>
      </div>
    `,
    )
    .join("");
}

function renderInventory() {
  el.inventoryTable.innerHTML = state.inventory
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.barcode)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.category || "Uncategorized")}</td>
        <td>${item.quantity}</td>
        <td>${escapeHtml(item.location || "Unassigned")}</td>
      </tr>
    `,
    )
    .join("");
}

function renderBoxes() {
  if (state.boxes.length === 0) {
    el.boxesList.className = "box-list empty-state";
    el.boxesList.innerHTML = `<i data-lucide="archive"></i><span>No boxes created yet.</span>`;
    return;
  }

  el.boxesList.className = "box-list";
  el.boxesList.innerHTML = state.boxes
    .map((box) => {
      const itemCount = box.items.reduce((total, item) => total + item.quantity, 0);
      return `
        <button class="box-entry" type="button" data-box-id="${escapeHtml(box.id)}">
          <div>
            <strong>${escapeHtml(box.id)}</strong>
            <span class="meta">${itemCount} items • ${escapeHtml(box.operator)} • ${formatTime(box.createdAt)}</span>
          </div>
          <span class="state-pill ${box.status}">${box.status}</span>
        </button>
      `;
    })
    .join("");

  document.querySelectorAll("[data-box-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeBoxId = button.dataset.boxId;
      el.boxId.value = state.activeBoxId;
      render();
      switchView("packing");
    });
  });
}

function renderActivity() {
  if (state.activity.length === 0) {
    el.activityFeed.className = "activity-feed empty-state";
    el.activityFeed.innerHTML = `<i data-lucide="history"></i><span>No scan activity yet.</span>`;
    return;
  }

  el.activityFeed.className = "activity-feed";
  el.activityFeed.innerHTML = state.activity
    .slice(0, 60)
    .map(
      (entry) => `
      <div class="activity-entry">
        <div>
          <strong>${escapeHtml(entry.type)}</strong>
          <span class="meta">${escapeHtml(entry.details)} • ${escapeHtml(entry.operator)}</span>
        </div>
        <span class="meta">${formatTime(entry.time)}</span>
      </div>
    `,
    )
    .join("");
}

function renderQrPreview() {
  const box = currentBox();
  if (!box) {
    el.boxQrImage.removeAttribute("src");
    el.boxQrImage.alt = "";
    el.boxQrLink.textContent = "Create or select a box";
    el.boxQrLink.removeAttribute("href");
    return;
  }

  const url = `${window.location.origin}${window.location.pathname}?box=${encodeURIComponent(box.id)}`;
  el.boxQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  el.boxQrImage.alt = `QR code for ${box.id}`;
  el.boxQrLink.href = url;
  el.boxQrLink.textContent = url;
}

function switchView(viewId) {
  el.navTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewId));
  el.views.forEach((view) => view.classList.toggle("active", view.id === viewId));
}

function exportCsv() {
  const rows = [["Box ID", "Status", "Barcode", "Item", "Category", "Quantity", "Operator"]];

  state.boxes.forEach((box) => {
    box.items.forEach((item) => {
      rows.push([
        box.id,
        box.status,
        item.barcode,
        item.name,
        item.category || "",
        item.quantity,
        box.operator,
      ]);
    });
  });

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `packtrack-export-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function addInventoryItem() {
  const data = {
    barcode: document.querySelector("#itemBarcode").value.trim(),
    name: document.querySelector("#itemName").value.trim(),
    category: document.querySelector("#itemCategory").value.trim() || "Uncategorized",
    quantity: Number(document.querySelector("#itemQuantity").value || 0),
    location: document.querySelector("#itemLocation").value.trim() || "Unassigned",
    operator: el.operatorName.value.trim() || "Demo operator",
  };

  state = await api("/items", {
    method: "POST",
    body: JSON.stringify(data),
  });

  el.itemForm.reset();
  el.itemDialog.close();
  setStatus(`${data.name} is now available to scan.`, "good");
  render();
}

async function resetDemo() {
  state = await api("/reset", { method: "POST" });
  state.activeBoxId = "BOX-1001";
  el.boxId.value = state.activeBoxId;
  setStatus("Demo backend reset to starting data.", "good");
  render();
}

async function toggleCamera() {
  if (cameraStream) {
    stopCamera();
    return;
  }

  if (!("BarcodeDetector" in window)) {
    setStatus("Camera barcode scanning is not supported in this browser. USB scanners still work.", "warn");
    return;
  }

  try {
    barcodeDetector = new BarcodeDetector({
      formats: ["code_128", "code_39", "ean_13", "ean_8", "qr_code", "upc_a", "upc_e"],
    });
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    el.cameraPreview.srcObject = cameraStream;
    await el.cameraPreview.play();
    el.scanStage.classList.add("camera-on");
    scanLoopActive = true;
    detectFromCamera();
  } catch (error) {
    setStatus("Camera permission was blocked or unavailable.", "warn");
  }
}

function stopCamera() {
  scanLoopActive = false;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  el.cameraPreview.srcObject = null;
  el.scanStage.classList.remove("camera-on");
}

async function detectFromCamera() {
  if (!scanLoopActive || !barcodeDetector) return;

  try {
    const detections = await barcodeDetector.detect(el.cameraPreview);
    if (detections.length > 0) {
      const rawValue = detections[0].rawValue;
      const parsedBox = new URL(rawValue, window.location.origin).searchParams.get("box");
      if (parsedBox) {
        state.activeBoxId = parsedBox.toUpperCase();
        el.boxId.value = state.activeBoxId;
        setStatus(`${state.activeBoxId} loaded from QR scan.`, "good");
        render();
      } else {
        await addScan(rawValue);
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  } catch (error) {
    scanLoopActive = false;
    setStatus("Camera scanning paused.", "warn");
  }

  requestAnimationFrame(detectFromCamera);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

el.navTabs.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
el.newBoxButton.addEventListener("click", () => createBox());
el.scanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addScan(el.barcodeInput.value);
});
el.sealBoxButton.addEventListener("click", sealCurrentBox);
el.shipBoxButton.addEventListener("click", shipCurrentBox);
el.exportButton.addEventListener("click", exportCsv);
el.addItemButton.addEventListener("click", () => el.itemDialog.showModal());
el.closeItemDialogButton.addEventListener("click", () => el.itemDialog.close());
el.itemForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addInventoryItem();
});
el.cameraButton.addEventListener("click", toggleCamera);
el.resetDemoButton.addEventListener("click", resetDemo);

loadState().catch((error) => {
  setStatus(`${error.message}. Run the demo with npm start.`, "warn");
});
