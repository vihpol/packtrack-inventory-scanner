const STORAGE_KEY = "packtrack-demo-state";

const starterInventory = [
  {
    barcode: "SW-C9300-48P",
    name: "Cisco Catalyst 9300 48P Switch",
    category: "Switches",
    quantity: 8,
    location: "Aisle 1, Rack B",
  },
  {
    barcode: "RTR-ISR4331",
    name: "Cisco ISR 4331 Router",
    category: "Routers",
    quantity: 5,
    location: "Aisle 1, Rack D",
  },
  {
    barcode: "SFP-10G-SR",
    name: "10G SR SFP Module",
    category: "Optics",
    quantity: 42,
    location: "Bin O-12",
  },
  {
    barcode: "CAB-CAT6-03",
    name: "3 ft CAT6 Patch Cable",
    category: "Cables",
    quantity: 180,
    location: "Bin C-03",
  },
  {
    barcode: "PWR-C13-6FT",
    name: "6 ft C13 Power Cord",
    category: "Power",
    quantity: 75,
    location: "Bin P-02",
  },
];

const state = loadState();
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
  exportButton: document.querySelector("#exportButton"),
  addItemButton: document.querySelector("#addItemButton"),
  itemDialog: document.querySelector("#itemDialog"),
  itemForm: document.querySelector("#itemForm"),
  closeItemDialogButton: document.querySelector("#closeItemDialogButton"),
  cameraButton: document.querySelector("#cameraButton"),
  cameraPreview: document.querySelector("#cameraPreview"),
  scanStage: document.querySelector(".scan-stage"),
  resetDemoButton: document.querySelector("#resetDemoButton"),
};

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return JSON.parse(saved);
  }

  return {
    inventory: starterInventory,
    boxes: [],
    activity: [],
    activeBoxId: "",
    operator: "",
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

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

function logActivity(type, details) {
  state.activity.unshift({
    id: crypto.randomUUID(),
    type,
    details,
    operator: state.operator || "Unassigned",
    time: new Date().toISOString(),
  });
}

function createBox(id = el.boxId.value.trim() || makeBoxId()) {
  const normalized = id.toUpperCase();
  const existing = state.boxes.find((box) => box.id === normalized);

  if (existing) {
    state.activeBoxId = normalized;
    setStatus(`${normalized} reopened.`, "good");
  } else {
    state.boxes.unshift({
      id: normalized,
      status: "open",
      createdAt: new Date().toISOString(),
      sealedAt: "",
      operator: state.operator || "Unassigned",
      items: [],
    });
    state.activeBoxId = normalized;
    logActivity("Box created", normalized);
    setStatus(`${normalized} is ready for scans.`, "good");
  }

  el.boxId.value = normalized;
  saveAndRender();
  el.barcodeInput.focus();
}

function findInventory(barcode) {
  return state.inventory.find(
    (item) => item.barcode.toLowerCase() === barcode.toLowerCase(),
  );
}

function addScan(barcode) {
  const code = barcode.trim();
  if (!code) return;

  let box = currentBox();
  if (!box) {
    createBox();
    box = currentBox();
  }

  if (box.status === "sealed") {
    setStatus(`${box.id} is sealed. Create or reopen another box.`, "warn");
    return;
  }

  const item = findInventory(code);
  if (!item) {
    setStatus(`${code} is not in inventory. Add it first.`, "warn");
    el.itemDialog.showModal();
    document.querySelector("#itemBarcode").value = code;
    document.querySelector("#itemName").focus();
    return;
  }

  if (item.quantity <= 0) {
    setStatus(`${item.name} is out of stock.`, "warn");
    return;
  }

  const packed = box.items.find((entry) => entry.barcode === item.barcode);
  if (packed) {
    packed.quantity += 1;
  } else {
    box.items.push({
      barcode: item.barcode,
      name: item.name,
      category: item.category,
      quantity: 1,
    });
  }

  item.quantity -= 1;
  logActivity("Item packed", `${item.name} into ${box.id}`);
  setStatus(`${item.name} added to ${box.id}.`, "good");
  el.barcodeInput.value = "";
  saveAndRender();
}

function sealCurrentBox() {
  const box = currentBox();
  if (!box) {
    setStatus("Create a box before sealing.", "warn");
    return;
  }

  box.status = "sealed";
  box.sealedAt = new Date().toISOString();
  logActivity("Box sealed", box.id);
  setStatus(`${box.id} sealed.`, "good");
  saveAndRender();
}

function saveAndRender() {
  state.operator = el.operatorName.value.trim();
  saveState();
  render();
}

function render() {
  renderMetrics();
  renderCurrentBox();
  renderInventory();
  renderBoxes();
  renderActivity();
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
    : "Create a box to begin.";
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
          <span class="state-pill ${box.status === "sealed" ? "sealed" : ""}">${box.status}</span>
        </button>
      `;
    })
    .join("");

  document.querySelectorAll("[data-box-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeBoxId = button.dataset.boxId;
      el.boxId.value = state.activeBoxId;
      saveAndRender();
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

function addInventoryItem() {
  const barcode = document.querySelector("#itemBarcode").value.trim();
  const existing = findInventory(barcode);
  const data = {
    barcode,
    name: document.querySelector("#itemName").value.trim(),
    category: document.querySelector("#itemCategory").value.trim() || "Uncategorized",
    quantity: Number(document.querySelector("#itemQuantity").value || 0),
    location: document.querySelector("#itemLocation").value.trim() || "Unassigned",
  };

  if (existing) {
    Object.assign(existing, data, { quantity: existing.quantity + data.quantity });
    logActivity("Inventory updated", data.name);
  } else {
    state.inventory.push(data);
    logActivity("Inventory added", data.name);
  }

  el.itemForm.reset();
  el.itemDialog.close();
  saveAndRender();
  setStatus(`${data.name} is now available to scan.`, "good");
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
      addScan(detections[0].rawValue);
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
el.operatorName.value = state.operator;
el.boxId.value = state.activeBoxId || makeBoxId();
el.operatorName.addEventListener("input", saveAndRender);
el.newBoxButton.addEventListener("click", () => createBox());
el.scanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addScan(el.barcodeInput.value);
});
el.sealBoxButton.addEventListener("click", sealCurrentBox);
el.exportButton.addEventListener("click", exportCsv);
el.addItemButton.addEventListener("click", () => el.itemDialog.showModal());
el.closeItemDialogButton.addEventListener("click", () => el.itemDialog.close());
el.itemForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addInventoryItem();
});
el.cameraButton.addEventListener("click", toggleCamera);
el.resetDemoButton.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

render();
