const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "packtrack-db.json");
const MAX_BODY_BYTES = 1024 * 1024;
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
    incoming: [],
    outgoing: [],
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

  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    data.inventory = Array.isArray(data.inventory) ? data.inventory : [];
    data.incoming = Array.isArray(data.incoming) ? data.incoming : [];
    data.outgoing = Array.isArray(data.outgoing) ? data.outgoing : [];
    data.activity = Array.isArray(data.activity) ? data.activity : [];
    data.inventory = data.inventory.map(normalizeItemShape);
    return data;
  } catch (error) {
    const backupPath = `${DB_PATH}.broken-${Date.now()}`;
    fs.copyFileSync(DB_PATH, backupPath);
    const fresh = starterData();
    fresh.activity.unshift({
      id: newId(),
      type: "Database recovered",
      details: "Bad demo data was backed up and replaced",
      time: now(),
    });
    writeDb(fresh);
    return fresh;
  }
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
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
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

function normalizeItemShape(item) {
  return {
    barcode: normalizeBarcode(item.barcode),
    description: String(item.description || item.name || "Scanned product").trim(),
    cost: Number.isFinite(Number(item.cost)) ? Number(item.cost) : 0,
    quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 0,
    aliases: Array.isArray(item.aliases) ? item.aliases.map(normalizeBarcode).filter(Boolean) : [],
  };
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

function itemLabel(item) {
  return item.description || item.name || item.barcode;
}

function makeLogEntry(type, item, quantity, direction) {
  return {
    id: newId(),
    type,
    barcode: item.barcode,
    description: itemLabel(item),
    cost: item.cost,
    quantity,
    direction,
    time: now(),
  };
}

function pushActivity(data, type, details) {
  data.activity.unshift({
    id: newId(),
    type,
    details,
    time: now(),
  });
}

function incomingScan(data, product) {
  const barcode = normalizeBarcode(product.barcode);
  const quantity = Math.max(1, Number(product.quantity || 1));
  const providedDescription = String(product.description || product.name || "").trim();
  const providedCost = product.cost !== undefined && product.cost !== null && product.cost !== "";
  const description = providedDescription || `Scanned item ${barcode}`;
  const cost = providedCost && Number.isFinite(Number(product.cost)) ? Number(product.cost) : 0;

  if (!barcode) {
    throw new Error("Barcode is required");
  }

  let item = findInventory(data, barcode);
  if (item) {
    if (providedDescription) {
      item.description = providedDescription;
    }
    if (providedCost) {
      item.cost = cost;
    }
    item.quantity += quantity;
  } else {
    item = normalizeItemShape({ barcode, description, cost, quantity });
    data.inventory.push(item);
  }

  const entry = makeLogEntry("Incoming scan", item, quantity, "incoming");
  data.incoming.unshift(entry);
  pushActivity(data, "Incoming inventory", `${itemLabel(item)} quantity increased to ${item.quantity}`);

  return {
    matched: true,
    mode: "incoming",
    scannedBarcode: barcode,
  };
}

function outgoingScan(data, barcode) {
  const normalized = normalizeBarcode(barcode);
  const item = findInventory(data, normalized);

  if (!item) {
    pushActivity(data, "Unknown outgoing scan", `${normalized || "Product"} is not in inventory`);
    return {
      matched: false,
      mode: "outgoing",
      scannedBarcode: normalized,
    };
  }
  if (item.quantity <= 0) {
    pushActivity(data, "Rejected outgoing scan", `${itemLabel(item)} is out of stock`);
    throw new Error(`${itemLabel(item)} is out of stock`);
  }

  item.quantity -= 1;
  const entry = makeLogEntry("Outgoing scan", item, 1, "outgoing");
  data.outgoing.unshift(entry);
  pushActivity(data, "Outgoing inventory", `${itemLabel(item)} quantity reduced to ${item.quantity}`);

  return {
    matched: true,
    mode: "outgoing",
    scannedBarcode: normalized,
  };
}

function addProduct(data, product) {
  const barcode = normalizeBarcode(product.barcode);
  const description = String(product.description || product.name || "").trim();
  const cost = Number(product.cost || 0);
  const quantity = Number(product.quantity || 0);
  const aliases = Array.isArray(product.aliases)
    ? product.aliases.map(normalizeBarcode).filter(Boolean)
    : [];

  if (!barcode || !description) {
    throw new Error("Product barcode and description are required");
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("Quantity must be 0 or higher");
  }
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error("Cost must be 0 or higher");
  }

  const existing = findInventory(data, barcode);
  if (existing) {
    existing.description = description;
    existing.cost = cost;
    existing.quantity = quantity;
    existing.aliases = aliases;
  } else {
    data.inventory.push({ barcode, description, cost, quantity, aliases });
  }

  pushActivity(data, "Product added", `${description} is ready to scan`);
}

function scanProduct(data, body) {
  const barcode = normalizeBarcode(body.barcode);
  const mode = String(body.mode || "smart").toLowerCase();

  if (mode === "incoming" || mode === "in") {
    return incomingScan(data, body);
  }
  if (mode === "outgoing" || mode === "out") {
    return outgoingScan(data, barcode);
  }

  return findInventory(data, barcode) ? outgoingScan(data, barcode) : incomingScan(data, body);
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
        const scanResult = scanProduct(nextData, body);
        writeDb(nextData);
        return Object.assign({}, nextData, scanResult);
      });
      sendJson(res, 200, data);
    } catch (error) {
      sendError(res, 400, error.message);
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
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already running. Open http://localhost:${PORT} instead of starting another server.`);
    process.exit(0);
  }

  console.error("Server error:", error.message);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("Unexpected server error:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("Unexpected async server error:", error.message || error);
});
