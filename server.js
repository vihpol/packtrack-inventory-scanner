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
    inventory: [
      { barcode: "SW-C9300-48P", name: "Cisco Catalyst 9300 48P Switch", quantity: 8 },
      { barcode: "RTR-ISR4331", name: "Cisco ISR 4331 Router", quantity: 5 },
      { barcode: "SFP-10G-SR", name: "10G SR SFP Module", quantity: 42 },
      { barcode: "CAB-CAT6-03", name: "3 ft CAT6 Patch Cable", quantity: 180 },
      { barcode: "PWR-C13-6FT", name: "6 ft C13 Power Cord", quantity: 75 },
    ],
    activity: [
      {
        id: newId(),
        type: "Demo ready",
        details: "Scan any product barcode to update inventory",
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
