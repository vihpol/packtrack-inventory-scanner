const DEMO_BOXES = ["BOX-1001", "BOX-1002"];

const el = {
  scanForm: document.querySelector("#scanForm"),
  scanInput: document.querySelector("#scanInput"),
  status: document.querySelector("#status"),
  inventoryBody: document.querySelector("#inventoryBody"),
  resetButton: document.querySelector("#resetButton"),
  scanLog: document.querySelector("#scanLog"),
  qrList: document.querySelector("#qrList"),
  cameraButton: document.querySelector("#cameraButton"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraFrame: document.querySelector(".camera-frame"),
};

let previousInventory = new Map();
let cameraStream = null;
let detector = null;
let cameraActive = false;

function normalizeScan(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw, window.location.origin);
    return (url.searchParams.get("box") || raw).trim().toUpperCase();
  } catch (error) {
    return raw.toUpperCase();
  }
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

function renderInventory(items) {
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
  if (!latest) {
    el.scanLog.textContent = "No box scanned yet.";
    return;
  }

  el.scanLog.textContent = `${latest.type}: ${latest.details}`;
}

async function loadState() {
  const data = await api("/api/state");
  renderInventory(data.inventory);
  renderLog(data.activity);
}

async function scanBox(value) {
  const boxId = normalizeScan(value);
  if (!boxId) return;

  setStatus(`Scanning ${boxId}...`);

  try {
    const result = await api("/api/scan-box", {
      method: "POST",
      body: JSON.stringify({ boxId }),
    });

    renderInventory(result.inventory);
    renderLog(result.activity);
    setStatus(`${boxId} scanned. Inventory updated.`, "ok");
    el.scanInput.value = boxId;
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

async function resetDemo() {
  const data = await api("/api/reset", { method: "POST" });
  previousInventory = new Map();
  renderInventory(data.inventory);
  renderLog([]);
  el.scanInput.value = DEMO_BOXES[0];
  setStatus("Demo reset. Scan BOX-1001 or BOX-1002.", "ok");
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
      await scanBox(codes[0].rawValue);
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

el.qrList.innerHTML = DEMO_BOXES.map(
  (boxId) => `
    <div class="qr-tile">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(boxId)}" alt="QR code for ${boxId}" />
      <p>${boxId}</p>
    </div>
  `,
).join("");
el.scanForm.addEventListener("submit", (event) => {
  event.preventDefault();
  scanBox(el.scanInput.value);
});
el.resetButton.addEventListener("click", resetDemo);
el.cameraButton.addEventListener("click", toggleCamera);

loadState().catch((error) => setStatus(error.message, "warn"));
