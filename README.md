# Product Scan Inventory Demo

A minimal demo where scanning a real product barcode/QR code immediately updates inventory through a REST API.

## Try It

Run the backend demo server from this folder:

```bash
npm start
```

Then open:

```text
http://localhost:5173
```

If you run `npm start` again while the server is already open, the app will now tell you to use the existing `http://localhost:5173` page instead of failing with a scary port error.

## Demo Flow

1. Open the app.
2. Add a product with its real barcode/QR value and starting quantity.
3. Scan a QR code that opens `/scan?barcode=YOUR_REAL_BARCODE`.
4. The browser sends `POST /api/scan-product` to the backend.
5. The backend subtracts 1 from that product's inventory.
6. The inventory table updates immediately.

## Scanner Support

- The Mac page is an inventory dashboard. It does not use the camera.
- Use the Add product form to register a barcode and quantity without using `curl`.
- Phone camera testing works by scanning a QR code that opens `/scan?barcode=YOUR_REAL_BARCODE`.
- If a scanned code is unknown, the app shows it and lets you copy it into the Add product form.

## Phone Camera Test

Create a QR code whose value is:

```text
http://localhost:5173/scan?barcode=YOUR_REAL_BARCODE
```

For phone testing, expose the local server with an HTTPS tunnel:

```bash
npx localtunnel --port 5173
```

Use the `https://...` URL from localtunnel when building QR codes for phone scanning.

If localtunnel says "tunnel unavailable", the local app is usually still fine. Restart only the tunnel command and use the new HTTPS URL it prints.

## REST API

```bash
curl -X POST http://localhost:5173/api/scan-product \
  -H 'Content-Type: application/json' \
  -d '{"barcode":"YOUR_REAL_BARCODE"}'
```

Reset the demo:

```bash
curl -X POST http://localhost:5173/api/reset
```
