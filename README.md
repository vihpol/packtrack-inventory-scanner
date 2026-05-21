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

## Demo Flow

1. Open the app.
2. Scan a registered product barcode with a USB/Bluetooth scanner, camera scanner, or the manual Scan button.
3. The browser sends `POST /api/scan-product` to the backend.
4. The backend subtracts 1 from that product's inventory.
5. The inventory table updates immediately.

## Scanner Support

- USB and Bluetooth barcode scanners work as keyboard input. Scan the product barcode and the app updates inventory when the scanner sends Enter.
- Manual entry works for testing.
- Camera scanning uses the browser `BarcodeDetector` API when available.

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
