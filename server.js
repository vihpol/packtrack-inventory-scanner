const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "packtrack-db.json");
const DUPLICATE_SCAN_WINDOW_MS = 1800;
let mutationQueue = Promise.resolve();

function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function now() {
  return new Date().toISOString();
}

function starterData() {
  return {
    inventory: [],
    activity: [
      {
        id: newId(),
        type: "Demo ready",
        details: "Ready for registered product scans",
        time: now(),
      },
    ],
  };
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    writeDb(starterData());
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeBarcode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw, "http://scanner.local");
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

function findInventory(data, barcode) {
  const normalized = normalizeBarcode(barcode).toLowerCase();
  return data.inventory.find((item) => {
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    return [item.barcode].concat(aliases).some((code) => {
      return normalizeBarcode(code).toLowerCase() === normalized;
    });
  });
}

function scanProduct(data, barcode) {
  const normalized = normalizeBarcode(barcode);
  const item = findInventory(data, normalized);

  if (!item) {
    data.activity.unshift({
      id: newId(),
      type: "Rejected scan",
      details: `${normalized || "Product"} is not registered`,
      time: now(),
    });
    throw new Error(`${normalized || "Product"} was not found in inventory`);
  }
  if (item.quantity <= 0) {
    data.activity.unshift({
      id: newId(),
      type: "Rejected scan",
      details: `${item.name} is out of stock`,
      time: now(),
    });
    throw new Error(`${item.name} is out of stock`);
  }

  data.recentScans = data.recentScans || {};
  const lastScanAt = data.recentScans[item.barcode] || 0;
  if (Date.now() - lastScanAt < DUPLICATE_SCAN_WINDOW_MS) {
    data.activity.unshift({
      id: newId(),
      type: "Duplicate ignored",
      details: `${item.name} was just scanned`,
      time: now(),
    });
    throw new Error(`${item.name} was just scanned. Duplicate ignored.`);
  }

  item.quantity -= 1;
  data.recentScans[item.barcode] = Date.now();
  data.activity.unshift({
    id: newId(),
    type: "Product scanned",
    details: `${item.name} inventory reduced to ${item.quantity}`,
    time: now(),
  });
}

function addProduct(data, product) {
  const barcode = normalizeBarcode(product.barcode);
  const name = String(product.name || "").trim();
  const quantity = Number(product.quantity || 0);
  const aliases = Array.isArray(product.aliases)
    ? product.aliases.map(normalizeBarcode).filter(Boolean)
    : [];

  if (!barcode || !name) {
    throw new Error("Product barcode and name are required");
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("Quantity must be 0 or higher");
  }

  const existing = findInventory(data, barcode);
  if (existing) {
    existing.name = name;
    existing.quantity = quantity;
    existing.aliases = aliases;
  } else {
    data.inventory.push({ barcode, name, quantity, aliases });
  }

  data.activity.unshift({
    id: newId(),
    type: "Product added",
    details: `${name} is ready to scan`,
    time: now(),
  });
}

function runMutation(task) {
  const next = mutationQueue.then(task, task);
  mutationQueue = next.catch(() => {});
  return next;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, time: now() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, readDb());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const fresh = await runMutation(() => {
      const nextData = starterData();
      writeDb(nextData);
      return nextData;
    });
    sendJson(res, 200, fresh);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan-product") {
    const body = await readBody(req);

    try {
      const data = await runMutation(() => {
        const nextData = readDb();
        scanProduct(nextData, body.barcode);
        writeDb(nextData);
        return nextData;
      });
      sendJson(res, 200, data);
    } catch (error) {
      sendError(res, error.message.includes("Duplicate ignored") ? 409 : 400, error.message);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/products") {
    const body = await readBody(req);

    try {
      const data = await runMutation(() => {
        const nextData = readDb();
        addProduct(nextData, body);
        writeDb(nextData);
        return nextData;
      });
      sendJson(res, 200, data);
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  sendError(res, 404, "API route not found");
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" || url.pathname === "/scan" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, requested));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json",
    }[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

server.listen(PORT, () => {
  console.log(`Product scan demo running at http://localhost:${PORT}`);
});
