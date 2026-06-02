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
  const labelDetails = labelDetailsFromText(
    [item.rawText, item.description, item.modelRef, item.origin].filter(Boolean).join("\n"),
    item.barcode
  );
  return {
    barcode: normalizeBarcode(item.barcode),
    description: String(item.description || item.name || "Unidentified item").trim(),
    cost: Number.isFinite(Number(item.cost)) ? Number(item.cost) : 0,
    quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 0,
    aliases: Array.isArray(item.aliases) ? item.aliases.map(normalizeBarcode).filter(Boolean) : [],
    labelType: String(item.labelType || labelDetails.labelType || "").trim(),
    packageId: String(item.packageId || labelDetails.packageId || "").trim(),
    barcodePrefix: String(item.barcodePrefix || labelDetails.barcodePrefix || "").trim(),
    dpn: String(item.dpn || labelDetails.dpn || "").trim(),
    modelRef: String(item.modelRef || labelDetails.modelRef || "").trim(),
    origin: String(item.origin || labelDetails.origin || "").trim(),
    estimatedFields: normalizeEstimatedFields(item.estimatedFields),
  };
}

function normalizeEstimatedFields(fields) {
  const allowedFields = new Set(["barcode", "description", "labelType", "packageId", "barcodePrefix", "dpn", "modelRef", "origin"]);
  if (!Array.isArray(fields)) return [];
  return Array.from(
    new Set(
      fields
        .map((field) => String(field || "").trim())
        .filter((field) => allowedFields.has(field))
    )
  );
}

function mergeLabelDetails(item, product) {
  const details = labelDetailsFromText(
    [product.rawText, product.description, product.modelRef, product.origin].filter(Boolean).join("\n"),
    product.barcode || item.barcode
  );
  const fields = ["labelType", "packageId", "barcodePrefix", "dpn", "modelRef", "origin"];

  fields.forEach((field) => {
    const value = String(product[field] || details[field] || "").trim();
    if (value) item[field] = value;
  });
  item.estimatedFields = normalizeEstimatedFields(product.estimatedFields || item.estimatedFields);
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
    estimatedFields: normalizeEstimatedFields(item.estimatedFields),
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
    mergeLabelDetails(item, Object.assign({}, product, { barcode }));
    item.quantity += quantity;
  } else {
    item = normalizeItemShape({ barcode, description, cost, quantity });
    mergeLabelDetails(item, Object.assign({}, product, { barcode }));
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

function removeProductUnits(data, body) {
  const barcode = normalizeBarcode(body.barcode);
  const quantity = Math.max(1, Math.round(Number(body.quantity || 1)));
  const item = findInventory(data, barcode);

  if (!item) {
    throw new Error("Inventory entry was not found");
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw new Error("Units must be 1 or higher");
  }
  if (item.quantity < quantity) {
    throw new Error(`Only ${item.quantity} unit${item.quantity === 1 ? "" : "s"} available`);
  }

  item.quantity -= quantity;
  const entry = makeLogEntry("Outgoing adjustment", item, quantity, "outgoing");
  data.outgoing.unshift(entry);
  pushActivity(data, "Units removed", `${itemLabel(item)} quantity reduced to ${item.quantity}`);

  return {
    matched: true,
    mode: "outgoing",
    scannedBarcode: barcode,
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
  const details = labelDetailsFromText(
    [result.description, result.item, result.model, result.notes, result.rawText].filter(Boolean).join("\n"),
    barcode
  );
  const description = inferLabelDescription(
    [result.description, result.item, result.model, result.notes].filter(Boolean).join("\n"),
    barcode
  );
  const quantity = Number(result.quantity || result.units || 1);
  return {
    barcode,
    description,
    quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1,
    labelType: String(result.labelType || details.labelType || "").trim(),
    packageId: String(result.packageId || details.packageId || "").trim(),
    barcodePrefix: String(result.barcodePrefix || details.barcodePrefix || "").trim(),
    dpn: String(result.dpn || details.dpn || "").trim(),
    modelRef: String(result.modelRef || details.modelRef || "").trim(),
    origin: String(result.origin || details.origin || "").trim(),
    estimatedFields: normalizeEstimatedFields(result.estimatedFields),
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

function primaryBarcodeFromLabel(ocrText, decodedValues) {
  const details = labelDetailsFromText(ocrText, "");
  const candidates = uniqueValues(decodedValues).concat(barcodeCandidatesFromText(ocrText)).map(normalizeBarcode);

  if (details.barcodePrefix && details.packageId) {
    const ocrBarcode = normalizeBarcode(`${details.barcodePrefix}${details.packageId}`);
    const barcodeFromSameLabel = candidates
      .filter((value) => value.startsWith(details.barcodePrefix))
      .filter((value) => value.startsWith(ocrBarcode) || ocrBarcode.startsWith(value))
      .sort((a, b) => b.length - a.length)[0];
    return barcodeFromSameLabel || ocrBarcode;
  }

  const preferred =
    candidates.find((value) => /^3[SR][A-Z0-9]{12,}$/i.test(value)) ||
    candidates.find((value) => /^(S|N|R)\d{4}/i.test(value)) ||
    candidates.find((value) => /[A-Z]/.test(value) && value.length >= 18) ||
    candidates.find((value) => /^\d{18,}$/.test(value));

  return preferred || candidates[0] || "";
}

function inferLabelDescription(text, barcode) {
  const details = labelDetailsFromText(text, barcode);
  if (details.labelType) return details.labelType;

  const content = `${String(text || "")}\n${String(barcode || "")}`;
  const compactBarcode = normalizeBarcode(barcode);
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const modelLine = lines.find((line) =>
    /(^|\b)(S\d{4}|N\d{4}|R\d{4}|QSFP|SFP|XFP|AOC|DAC|switch|router|optic|transceiver)(\b|[-_])/i.test(line)
  );

  if (/QSFP|SFP|XFP|AOC|DAC|OPTIC|TRANSCEIVER/i.test(content)) {
    return modelLine ? cleanLabelText(modelLine) : "Optic / transceiver label";
  }
  if (/(^|\b)R\d{4}(\b|[-_])|ROUTER/i.test(content) || /^3R[A-Z0-9]/i.test(compactBarcode)) {
    return modelLine ? cleanLabelText(modelLine) : "Router serial label";
  }
  if (/(^|\b)(S\d{4}|N\d{4})(\b|[-_])|SWITCH/i.test(content) || /^3S[A-Z0-9]/i.test(compactBarcode)) {
    return modelLine ? cleanLabelText(modelLine) : "Switch serial label";
  }
  if (/CARTON|CTN|BOX|PKG|PACKAGE|PALLET|SHIP|TRACK|WAYBILL/i.test(content) || /^\d{18,}$/.test(compactBarcode)) {
    return "Carton / shipping label";
  }
  if (/(^|\b)(SN|SERIAL|S\/N)(\b|[A-Z0-9])/i.test(content)) {
    return "Equipment serial label";
  }

  return compactBarcode ? "Network equipment label" : "Scanned label";
}

function labelDetailsFromText(text, barcode) {
  const compactBarcode = normalizeBarcode(barcode);
  const content = `${String(text || "")}\n${compactBarcode}`;
  const normalizedText = content.replace(/\s+/g, " ");
  const details = {
    labelType: "",
    packageId: "",
    barcodePrefix: "",
    dpn: "",
    modelRef: "",
    origin: "",
  };

  const packageMatch = normalizedText.match(/\bPKG\s*ID\s*\(?([A-Z0-9]{2,4})\)?\s*([A-Z0-9._-]{8,})/i);
  if (packageMatch) {
    details.barcodePrefix = packageMatch[1].toUpperCase();
    details.packageId = packageMatch[2].toUpperCase();
  }

  if (
    details.barcodePrefix &&
    details.packageId &&
    compactBarcode.startsWith(details.barcodePrefix) &&
    compactBarcode.slice(details.barcodePrefix.length).startsWith(details.packageId)
  ) {
    details.packageId = compactBarcode.slice(details.barcodePrefix.length);
  } else if (!details.packageId && /^[A-Z0-9]{2}[A-Z0-9._-]{8,}$/i.test(compactBarcode)) {
    details.barcodePrefix = compactBarcode.slice(0, 2);
    details.packageId = compactBarcode.slice(2);
  }

  const barcodeDpnMatch = compactBarcode.match(/(0[A-Z0-9]{5})\d{2}$/i);
  const dpnMatch =
    barcodeDpnMatch ||
    normalizedText.match(/\bD\s*P\s*\/?\s*N\s*[:#-]?\s*([0O][A-Z0-9]{5})\b/i);
  if (dpnMatch) {
    details.dpn = dpnMatch[1].toUpperCase().replace(/^O/, "0");
  }

  const modelMatch =
    normalizedText.match(/\(([A-Z0-9]{2,}[-_][A-Z0-9-]{2,})\)/i) ||
    normalizedText.match(/\b((?:S|N|R)\d{4}[-_][A-Z0-9-]+|QSFP[A-Z0-9-]*|SFP[A-Z0-9-]*)\b/i);
  if (modelMatch) {
    details.modelRef = modelMatch[1].toUpperCase();
  }

  const originMatch = normalizedText.match(/\bMade\s+in\s+([A-Za-z][A-Za-z\s-]{2,30})/i);
  if (originMatch) {
    details.origin = `Made in ${cleanLabelText(originMatch[1]).replace(/\b\w/g, (letter) => letter.toUpperCase())}`;
  }

  details.labelType = inferLabelTypeFromDetails(details, content, compactBarcode);
  return details;
}

function inferLabelTypeFromDetails(details, content, barcode) {
  if (/QSFP|SFP|XFP|AOC|DAC|OPTIC|TRANSCEIVER/i.test(content)) return "Optic / transceiver label";
  if (/(^|\b)R\d{4}(\b|[-_])|ROUTER/i.test(content) || /^3R[A-Z0-9]/i.test(barcode)) return "Router serial label";
  if (/(^|\b)(S\d{4}|N\d{4})(\b|[-_])|SWITCH/i.test(content) || /^3S[A-Z0-9]/i.test(barcode)) return "Switch package label";
  if (/CARTON|CTN|BOX|PKG|PACKAGE|PALLET|SHIP|TRACK|WAYBILL/i.test(content) || /^\d{18,}$/.test(barcode)) return "Carton / shipping label";
  if (/(^|\b)(SN|SERIAL|S\/N)(\b|[A-Z0-9])/i.test(content)) return "Equipment serial label";
  return barcode ? "Network equipment label" : "Scanned label";
}

function cleanLabelText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^(model|item|description|type)\s*[:#-]\s*/i, "")
    .trim()
    .slice(0, 90);
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
      ["low-light.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-auto-level", "-brightness-contrast", "35x18", "-gamma", "0.78", "-sharpen", "0x1.1"]],
      ["low-light-strong.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-auto-level", "-modulate", "145,115", "-contrast-stretch", "1%x1%", "-sharpen", "0x1.4"]],
      ["large.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-normalize", "-sharpen", "0x1.2"]],
      ["deskew.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-normalize", "-deskew", "40%", "-sharpen", "0x1"]],
      ["threshold-55.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-normalize", "-threshold", "55%"]],
      ["bright-threshold.png", ["-resize", "3600x3600>", "-colorspace", "Gray", "-auto-level", "-brightness-contrast", "30x15", "-threshold", "58%"]],
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

    const ocrImage = path.join(tempDir, "ocr.png");
    await execFile("convert", [
      originalPath,
      "-auto-orient",
      "-resize",
      "3200x3200>",
      "-colorspace",
      "Gray",
      "-auto-level",
      "-brightness-contrast",
      "28x14",
      "-gamma",
      "0.82",
      "-sharpen",
      "0x1",
      ocrImage,
    ]);
    const ocr = await execFile("tesseract", [ocrImage, "stdout", "--psm", "6"]);
    const ocrText = ocr.stdout;

    const barcode = primaryBarcodeFromLabel(ocrText, decoded);
    const details = labelDetailsFromText(ocrText, barcode);
    const estimatedFields = ["description", "labelType"];
    if (!decoded.length && barcode) estimatedFields.push("barcode");
    return {
      barcode,
      description: details.labelType || inferLabelDescription(ocrText, barcode),
      quantity: 1,
      labelType: details.labelType,
      packageId: details.packageId,
      barcodePrefix: details.barcodePrefix,
      dpn: details.dpn,
      modelRef: details.modelRef,
      origin: details.origin,
      estimatedFields,
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
              "Return only JSON with keys: barcode, description, quantity, labelType, packageId, barcodePrefix, dpn, modelRef, origin, estimatedFields, confidence, notes. " +
              "Use barcode for the primary serial/SKU/barcode value. Extract DP/N, package ID prefix, model/reference codes like Z9432F-AC, and origin like Made in Taiwan when visible. Use quantity 1 if no quantity is visible. Do not guess values that are not visible. If any field is inferred instead of directly visible, include that field name in estimatedFields.",
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

  if (req.method === "PATCH" && url.pathname.startsWith("/api/products/")) {
    const barcode = decodeURIComponent(url.pathname.replace("/api/products/", ""));
    const body = await readBody(req);

    try {
      const data = await runMutation(() => {
        const nextData = readDb();
        const adjustment = removeProductUnits(nextData, Object.assign({}, body, { barcode }));
        writeDb(nextData);
        return Object.assign({}, nextData, adjustment);
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
      ".wasm": "application/wasm",
      ".xml": "application/xml",
      ".data": "application/octet-stream",
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
