const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "packtrack-db.json");

function newId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(16).toString("hex");
}

const starterData = {
  inventory: [
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
  ],
  boxes: [
    {
      id: "BOX-1001",
      status: "sealed",
      createdAt: new Date().toISOString(),
      sealedAt: new Date().toISOString(),
      shippedAt: "",
      operator: "Demo operator",
      items: [
        {
          barcode: "SW-C9300-48P",
          name: "Cisco Catalyst 9300 48P Switch",
          category: "Switches",
          quantity: 1,
        },
        {
          barcode: "SFP-10G-SR",
          name: "10G SR SFP Module",
          category: "Optics",
          quantity: 4,
        },
        {
          barcode: "CAB-CAT6-03",
          name: "3 ft CAT6 Patch Cable",
          category: "Cables",
          quantity: 10,
        },
      ],
    },
  ],
  activity: [
    {
      id: newId(),
      type: "Demo box staged",
      details: "BOX-1001 is ready to scan and ship",
      operator: "System",
      time: new Date().toISOString(),
    },
  ],
  operator: "",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    writeDb(clone(starterData));
  }
}

function readDb() {
  ensureDb();
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

function logActivity(data, type, details, operator) {
  data.activity.unshift({
    id: newId(),
    type,
    details,
    operator: operator || "Unassigned",
    time: new Date().toISOString(),
  });
}

function findInventory(data, barcode) {
  return data.inventory.find(
    (item) => item.barcode.toLowerCase() === String(barcode).toLowerCase(),
  );
}

function findBox(data, boxId) {
  return data.boxes.find((box) => box.id.toLowerCase() === String(boxId).toLowerCase());
}

function createBox(data, boxId, operator) {
  const normalized = String(boxId || "").trim().toUpperCase();
  if (!normalized) {
    throw new Error("Box ID is required");
  }

  let box = findBox(data, normalized);
  if (!box) {
    box = {
      id: normalized,
      status: "open",
      createdAt: new Date().toISOString(),
      sealedAt: "",
      shippedAt: "",
      operator: operator || "Unassigned",
      items: [],
    };
    data.boxes.unshift(box);
    logActivity(data, "Box created", normalized, operator);
  }
  return box;
}

async function handleApi(req, res, url) {
  const data = readDb();

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const fresh = clone(starterData);
    fresh.activity[0].id = newId();
    fresh.activity[0].time = new Date().toISOString();
    fresh.boxes[0].createdAt = new Date().toISOString();
    fresh.boxes[0].sealedAt = new Date().toISOString();
    writeDb(fresh);
    sendJson(res, 200, fresh);
    return;
  }

  const body = await readBody(req);

  if (req.method === "POST" && url.pathname === "/api/boxes") {
    createBox(data, body.id, body.operator);
    data.operator = body.operator || data.operator;
    writeDb(data);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/scan-item") {
    const box = createBox(data, body.boxId, body.operator);
    if (box.status === "shipped") {
      sendError(res, 409, `${box.id} has already shipped`);
      return;
    }

    const item = findInventory(data, body.barcode);
    if (!item) {
      sendError(res, 404, `${body.barcode} is not in inventory`);
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

    logActivity(data, "Item scanned into box", `${item.name} into ${box.id}`, body.operator);
    data.operator = body.operator || data.operator;
    writeDb(data);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/items") {
    const barcode = String(body.barcode || "").trim();
    if (!barcode || !body.name) {
      sendError(res, 400, "Barcode and item name are required");
      return;
    }

    const existing = findInventory(data, barcode);
    const quantity = Number(body.quantity || 0);
    if (existing) {
      existing.name = body.name;
      existing.category = body.category || "Uncategorized";
      existing.quantity += quantity;
      existing.location = body.location || "Unassigned";
      logActivity(data, "Inventory updated", body.name, body.operator);
    } else {
      data.inventory.push({
        barcode,
        name: body.name,
        category: body.category || "Uncategorized",
        quantity,
        location: body.location || "Unassigned",
      });
      logActivity(data, "Inventory added", body.name, body.operator);
    }

    writeDb(data);
    sendJson(res, 200, data);
    return;
  }

  const sealMatch = url.pathname.match(/^\/api\/boxes\/([^/]+)\/seal$/);
  if (req.method === "POST" && sealMatch) {
    const box = findBox(data, decodeURIComponent(sealMatch[1]));
    if (!box) {
      sendError(res, 404, "Box not found");
      return;
    }

    box.status = "sealed";
    box.sealedAt = new Date().toISOString();
    logActivity(data, "Box sealed", box.id, body.operator);
    writeDb(data);
    sendJson(res, 200, data);
    return;
  }

  const shipMatch = url.pathname.match(/^\/api\/boxes\/([^/]+)\/ship$/);
  if (req.method === "POST" && shipMatch) {
    const box = findBox(data, decodeURIComponent(shipMatch[1]));
    if (!box) {
      sendError(res, 404, "Box not found");
      return;
    }
    if (box.status === "shipped") {
      sendError(res, 409, `${box.id} has already updated inventory`);
      return;
    }
    if (box.items.length === 0) {
      sendError(res, 400, `${box.id} has no items`);
      return;
    }

    for (const packed of box.items) {
      const item = findInventory(data, packed.barcode);
      if (!item) {
        sendError(res, 404, `${packed.barcode} is missing from inventory`);
        return;
      }
      if (item.quantity < packed.quantity) {
        sendError(res, 409, `Not enough ${item.name} available`);
        return;
      }
    }

    for (const packed of box.items) {
      const item = findInventory(data, packed.barcode);
      item.quantity -= packed.quantity;
    }

    box.status = "shipped";
    box.shippedAt = new Date().toISOString();
    logActivity(data, "Inventory updated from box scan", `${box.id} shipped`, body.operator);
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
  console.log(`PackTrack demo server running at http://localhost:${PORT}`);
});
