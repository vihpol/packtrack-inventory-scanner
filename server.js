const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const util = require("util");
const childProcess = require("child_process");
const QRCode = require("qrcode");

if (typeof global.TextEncoder === "undefined" && util.TextEncoder) {
  global.TextEncoder = util.TextEncoder;
}
if (typeof global.TextDecoder === "undefined" && util.TextDecoder) {
  global.TextDecoder = util.TextDecoder;
}

const PORT = Number(process.env.PORT || 5173);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 5443);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "packtrack-db.json");
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || path.join(ROOT, "certs", "local-server.key");
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH || path.join(ROOT, "certs", "local-server.crt");
const PUBLIC_URL_PATH = path.join(ROOT, ".public-url");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
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
        type: "Ready",
        details: "Ready for registered product scans",
        time: now(),
      },
    ],
  };
}

function demoData() {
  const data = {
    inventory: [
      normalizeItemShape({
        barcode: "MICAS-S5810-01",
        description: "S5810-48TS 48-port switch",
        quantity: 5,
      }),
      normalizeItemShape({
        barcode: "MICAS-S6810-02",
        description: "S6810-32X 100G spine switch",
        quantity: 3,
      }),
      normalizeItemShape({
        barcode: "MICAS-QSFP-100G",
        description: "100G QSFP28 optical module",
        quantity: 18,
      }),
    ],
    incoming: [],
    outgoing: [],
    activity: [],
  };

  const received = makeLogEntry("Incoming scan", data.inventory[2], 4, "incoming");
  const issued = makeLogEntry("Outgoing scan", data.inventory[0], 1, "outgoing");
  data.incoming.unshift(received);
  data.outgoing.unshift(issued);
  pushActivity(data, "Demo data loaded", "Sample Micas hardware records are ready");
  return data;
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
      details: "Bad inventory data was backed up and replaced",
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

function sendSvg(res, svg) {
  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "no-store",
  });
  res.end(svg);
}

function getLanAddresses() {
  return Object.keys(os.networkInterfaces())
    .reduce((addresses, name) => addresses.concat(os.networkInterfaces()[name]), [])
    .filter((address) => {
      return address && address.family === "IPv4" && !address.internal;
    })
    .map((address) => address.address);
}

function getPublicUrl() {
  const fromEnv = String(process.env.PUBLIC_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  if (!fs.existsSync(PUBLIC_URL_PATH)) return "";
  return fs.readFileSync(PUBLIC_URL_PATH, "utf8").trim().replace(/\/$/, "");
}

function getNetworkInfo() {
  const addresses = getLanAddresses();
  const primaryAddress = addresses[0] || "localhost";
  const publicUrl = getPublicUrl();
  return {
    addresses,
    dashboardUrl: publicUrl || `http://${primaryAddress}:${PORT}`,
    scannerUrl: publicUrl ? `${publicUrl}/scanner` : `https://${primaryAddress}:${HTTPS_PORT}/scanner`,
    httpsPort: HTTPS_PORT,
    publicUrl,
  };
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
    description: String(item.description || item.name || "Unidentified item").trim(),
    cost: Number.isFinite(Number(item.cost)) ? Number(item.cost) : 0,
    quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 0,
    aliases: Array.isArray(item.aliases) ? item.aliases.map(normalizeBarcode).filter(Boolean) : [],
  };
}

function cleanDescription(product, barcode) {
  const description = String(product.description || product.name || "").trim();
  if (!description) return "";

  const normalized = description.toLowerCase();
  const genericDescriptions = new Set([
    "scanned item",
    `scanned item ${barcode}`.toLowerCase(),
    "scanned product",
    `scanned product ${barcode}`.toLowerCase(),
    "unidentified item",
  ]);

  return genericDescriptions.has(normalized) ? "" : description;
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
  const providedDescription = cleanDescription(product, barcode);
  const providedCost = product.cost !== undefined && product.cost !== null && product.cost !== "";
  const description = providedDescription || "Unidentified item";
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

function deleteProduct(data, barcode) {
  const normalized = normalizeBarcode(barcode);
  const index = data.inventory.findIndex((item) => item.barcode === normalized);

  if (index === -1) {
    throw new Error("Inventory entry was not found");
  }

  const [removed] = data.inventory.splice(index, 1);
  pushActivity(data, "Product deleted", `${itemLabel(removed)} was removed from inventory`);
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

function requestJson(options, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      Object.assign({}, options, {
        headers: Object.assign({}, options.headers || {}, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        }),
      }),
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = responseBody ? JSON.parse(responseBody) : {};
          } catch (error) {
            reject(new Error("AI service returned an invalid response"));
            return;
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const message =
              parsed.error && parsed.error.message
                ? parsed.error.message
                : `AI service request failed with status ${res.statusCode}`;
            reject(new Error(message));
            return;
          }
          resolve(parsed);
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("AI service timed out"));
    });
    req.write(body);
    req.end();
  });
}

function responseText(response) {
  if (response.output_text) return response.output_text;
  const chunks = [];
  (response.output || []).forEach((item) => {
    (item.content || []).forEach((content) => {
      if (content.text) chunks.push(content.text);
      if (content.type === "output_text" && content.annotations === undefined && content.text) chunks.push(content.text);
    });
  });
  return chunks.join("\n").trim();
}

function parseJsonFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("AI did not return label details");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI did not return valid label details");
    return JSON.parse(match[0]);
  }
}

function cleanAnalysisResult(result) {
  const barcode = normalizeBarcode(result.barcode || result.sku || result.serial || "");
  const description = String(result.description || result.item || result.model || "").trim();
  const quantity = Number(result.quantity || result.units || 1);
  return {
    barcode,
    description,
    quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1,
    confidence: String(result.confidence || "").trim(),
    notes: String(result.notes || "").trim(),
  };
}

function execFile(command, args, options = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, { timeout: 15000, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error,
      });
    });
  });
}

function parseImageDataUrl(image) {
  const match = String(image || "").match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i);
  if (!match) {
    throw new Error("Upload a PNG, JPEG, or WebP label photo");
  }
  const ext = match[1].toLowerCase().replace("jpeg", "jpg");
  return {
    ext,
    buffer: Buffer.from(match[2], "base64"),
  };
}

function barcodeCandidatesFromText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[^A-Za-z0-9._-]/g, "").trim())
    .filter((line) => line.length >= 6)
    .sort((a, b) => b.length - a.length);
}

function descriptionFromOcr(text, barcode) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const modelLine =
    lines.find((line) => /S\d{4}|N\d{4}|switch|router|optic|transceiver/i.test(line));
  if (modelLine) return modelLine.replace(/\s+/g, " ").slice(0, 90);
  return barcode ? "Network equipment label" : "Scanned label";
}

async function makeImageVariant(inputPath, outputPath, operations) {
  const result = await execFile("convert", [inputPath, "-auto-orient"].concat(operations, [outputPath]));
  return result.ok && fs.existsSync(outputPath);
}

async function decodeBarcodeFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const result = await execFile("zbarimg", ["--raw", "-q", filePath], { timeout: 6000 });
  return barcodeCandidatesFromText(result.stdout);
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function removeDirSafe(dirPath) {
  if (fs.rmSync) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(dirPath)) return;
  fs.readdirSync(dirPath).forEach((entry) => {
    const entryPath = path.join(dirPath, entry);
    const stat = fs.lstatSync(entryPath);
    if (stat.isDirectory()) {
      removeDirSafe(entryPath);
    } else {
      fs.unlinkSync(entryPath);
    }
  });
  fs.rmdirSync(dirPath);
}

async function localLabelAnalysis(image) {
  const parsed = parseImageDataUrl(image);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "packtrack-label-"));
  const originalPath = path.join(tempDir, `label.${parsed.ext}`);
  fs.writeFileSync(originalPath, parsed.buffer);

  try {
    const decoded = [];
    const variantSpecs = [
      ["original.png", []],
      ["gray.png", ["-colorspace", "Gray", "-normalize"]],
      ["large.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-normalize", "-sharpen", "0x1.2"]],
      ["deskew.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-normalize", "-deskew", "40%", "-sharpen", "0x1"]],
      ["threshold-55.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-normalize", "-threshold", "55%"]],
      ["adaptive.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-normalize", "-lat", "28x28+8%"]],
      ["contrast.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-contrast-stretch", "2%x2%", "-sharpen", "0x1.4"]],
    ];

    for (const spec of variantSpecs) {
      const basePath = path.join(tempDir, spec[0]);
      if (await makeImageVariant(originalPath, basePath, spec[1])) {
        decoded.push(...await decodeBarcodeFile(basePath));
        if (decoded.length) break;
      }
      for (const degrees of ["90", "180", "270"]) {
        const rotatedPath = path.join(tempDir, `${path.basename(spec[0], ".png")}-${degrees}.png`);
        if (await makeImageVariant(basePath, rotatedPath, ["-rotate", degrees])) {
          decoded.push(...await decodeBarcodeFile(rotatedPath));
          if (decoded.length) break;
        }
      }
      if (decoded.length) break;
    }

    let ocrText = "";
    if (!decoded.length) {
      const ocrImage = path.join(tempDir, "ocr.png");
      await execFile("convert", [originalPath, "-auto-orient", "-colorspace", "Gray", "-normalize", "-resize", "3200x3200>", ocrImage]);
      const ocr = await execFile("tesseract", [ocrImage, "stdout", "--psm", "6"]);
      ocrText = ocr.stdout;
    }

    const candidates = uniqueValues(decoded).concat(barcodeCandidatesFromText(ocrText));
    const barcode = normalizeBarcode(candidates[0] || "");
    return {
      barcode,
      description: descriptionFromOcr(ocrText, barcode),
      quantity: 1,
      confidence: decoded.length ? "barcode decoded locally" : "OCR estimate",
      notes: decoded.length ? "Decoded with local zbar barcode reader." : "No barcode decoded; used local OCR text.",
    };
  } finally {
    removeDirSafe(tempDir);
  }
}

async function analyzeLabelPhoto(image) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return localLabelAnalysis(image);
  }
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(String(image || ""))) {
    throw new Error("Upload a PNG, JPEG, or WebP label photo");
  }

  const payload = {
    model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Analyze this network equipment or shipping label photo. Extract the best visible SKU, serial, barcode text, model, hardware type, and quantity/units. " +
              "Return only JSON with keys: barcode, description, quantity, confidence, notes. " +
              "Use barcode for the primary serial/SKU/barcode value. Use description for a concise inventory item name. Use quantity 1 if no quantity is visible. Do not guess values that are not visible.",
          },
          {
            type: "input_image",
            image_url: image,
            detail: "high",
          },
        ],
      },
    ],
    max_output_tokens: 500,
  };

  const response = await requestJson(
    {
      hostname: "api.openai.com",
      path: "/v1/responses",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    payload
  );
  return cleanAnalysisResult(parseJsonFromText(responseText(response)));
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, time: now() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/network") {
    sendJson(res, 200, getNetworkInfo());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/scanner-qr.svg") {
    const svg = await QRCode.toString(getNetworkInfo().scannerUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      color: {
        dark: "#07151c",
        light: "#ffffff",
      },
    });
    sendSvg(res, svg);
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

  if (req.method === "POST" && url.pathname === "/api/demo") {
    const demo = await runMutation(() => {
      const nextData = demoData();
      writeDb(nextData);
      return nextData;
    });
    sendJson(res, 200, demo);
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

  if (req.method === "POST" && url.pathname === "/api/analyze-label") {
    const body = await readBody(req);

    try {
      const analysis = await analyzeLabelPhoto(body.image);
      sendJson(res, 200, analysis);
    } catch (error) {
      sendError(res, error.message.indexOf("OPENAI_API_KEY") !== -1 ? 503 : 400, error.message);
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

  if (req.method === "DELETE" && url.pathname.startsWith("/api/products/")) {
    const barcode = decodeURIComponent(url.pathname.replace("/api/products/", ""));

    try {
      const data = await runMutation(() => {
        const nextData = readDb();
        deleteProduct(nextData, barcode);
        writeDb(nextData);
        return nextData;
      });
      sendJson(res, 200, data);
    } catch (error) {
      sendError(res, 404, error.message);
    }
    return;
  }

  sendError(res, 404, "API route not found");
}

function serveStatic(req, res, url) {
  const appRoutes = ["/", "/scan", "/scanner"];
  const requested = appRoutes.includes(url.pathname) ? "/index.html" : url.pathname;
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

async function routeRequest(req, res) {
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
}

const server = http.createServer(routeRequest);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Inventory scanner running at http://localhost:${PORT}`);
});

if (fs.existsSync(HTTPS_KEY_PATH) && fs.existsSync(HTTPS_CERT_PATH)) {
  const secureServer = https.createServer(
    {
      key: fs.readFileSync(HTTPS_KEY_PATH),
      cert: fs.readFileSync(HTTPS_CERT_PATH),
    },
    routeRequest
  );

  secureServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`Secure phone scanner running at https://localhost:${HTTPS_PORT}/scanner`);
  });

  secureServer.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`HTTPS port ${HTTPS_PORT} is already running.`);
      return;
    }
    console.error("HTTPS server error:", error.message);
  });
} else {
  console.log("HTTPS disabled. Run scripts/setup-local-https.sh to create local certificates.");
}

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
