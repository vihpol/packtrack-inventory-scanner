# PackTrack Inventory Scanner

A browser-based demo for scanning networking equipment into boxes and updating inventory automatically.

## Try It

Run the backend demo server from this folder:

```bash
npm start
```

Then open:

```text
http://localhost:5173
```

To show the box QR flow directly:

```text
http://localhost:5173/?box=BOX-1001
```

`BOX-1001` is preloaded with demo equipment. Click **Mark Shipped** and the backend subtracts the box contents from inventory.

## Scanner Support

- USB and Bluetooth barcode scanners work as keyboard input. Click the scan field and scan an item.
- Manual entry works for testing.
- Camera scanning uses the browser `BarcodeDetector` API when available.

## How The Company-Style Demo Works

- The browser calls API routes under `/api`.
- `server.js` reads and writes a local JSON database file named `packtrack-db.json`.
- Scanning a box QR opens a URL like `http://localhost:5173/?box=BOX-1001`.
- Clicking **Mark Shipped** calls the backend, and the backend updates inventory counts.

## Demo Barcodes

- `SW-C9300-48P`
- `RTR-ISR4331`
- `SFP-10G-SR`
- `CAB-CAT6-03`
- `PWR-C13-6FT`
