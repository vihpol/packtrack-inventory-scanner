# Box Scan Inventory Demo

A minimal demo where scanning one box barcode/QR code immediately updates inventory through a REST API.

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
2. Scan `BOX-1001` or `BOX-1002` with a USB/Bluetooth scanner, camera scanner, or the manual Scan button.
3. The browser sends `POST /api/scan-box` to the backend.
4. The backend subtracts the items inside `BOX-1001` from inventory.
5. The inventory table updates immediately.

## Scanner Support

- USB and Bluetooth barcode scanners work as keyboard input. Click the scan field and scan the box.
- Manual entry works for testing.
- Camera scanning uses the browser `BarcodeDetector` API when available.

## REST API

```bash
curl -X POST http://localhost:5173/api/scan-box \
  -H 'Content-Type: application/json' \
  -d '{"boxId":"BOX-1001"}'
```

Reset the demo:

```bash
curl -X POST http://localhost:5173/api/reset
```
