const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "packtrack-db.json");

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
        details: "Add a real product, then scan its barcode",
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
  return String(value || "").trim().toUpperCase();
}

function findInventory(data, barcode) {
  return data.inventory.find(
    (item) => item.barcode.toLowerCase() === String(barcode).toLowerCase(),
  );
}

function scanProduct(data, barcode) {
  const normalized = normalizeBarcode(barcode);
  const item = findInventory(data, normalized);

  if (!item) {
    throw new Error(`${normalized || "Product"} was not found in inventory`);
  }
  if (item.quantity <= 0) {
    throw new Error(`${item.name} is out of stock`);
  }

  item.quantity -= 1;
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
  } else {
    data.inventory.push({ barcode, name, quantity });
  }

  data.activity.unshift({
    id: newId(),
    type: "Product added",
    details: `${name} is ready to scan`,
    time: now(),
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, readDb());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const fresh = starterData();
    writeDb(fresh);
    sendJson(res, 200, fresh);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan-product") {
    const data = readDb();
    const body = await readBody(req);

    try {
      scanProduct(data, body.barcode);
    } catch (error) {
      sendError(res, 400, error.message);
      return;
    }

    writeDb(data);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/products") {
    const data = readDb();
    const body = await readBody(req);

    try {
      addProduct(data, body);
    } catch (error) {
      sendError(res, 400, error.message);
      return;
    }

    writeDb(data);
    sendJson(res, 200, data);
    return;
  }

  sendError(res, 404, "API route not found");
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
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
