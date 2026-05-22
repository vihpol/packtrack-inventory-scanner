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
2. Scan a registered product barcode with a USB/Bluetooth scanner, camera scanner, or the manual Scan button.
3. The browser sends `POST /api/scan-product` to the backend.
4. The backend subtracts 1 from that product's inventory.
5. The inventory table updates immediately.

## Scanner Support

- USB and Bluetooth barcode scanners work as keyboard input. Scan the product barcode and the app updates inventory when the scanner sends Enter.
- Manual entry works for testing.
- Camera scanning uses the browser `BarcodeDetector` API when available, with an `html5-qrcode` fallback for browsers like mobile Safari.
- Phone browsers usually require HTTPS before they allow camera access. `http://localhost:5173` works on the same computer, but a phone opening your computer's LAN IP over plain HTTP may block the camera.
- Phone camera testing works by scanning a QR code that opens `/scan?barcode=YOUR_REAL_BARCODE`.

## Phone Camera Test

Create a QR code whose value is:

```text
http://localhost:5173/scan?barcode=YOUR_REAL_BARCODE
```

For phone camera testing, expose the local server with an HTTPS tunnel, then open the HTTPS URL on your phone:

```bash
npx localtunnel --port 5173
```

Use the `https://...` URL from localtunnel. When the phone opens that URL, the app can request camera permission and scans can update inventory.

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
