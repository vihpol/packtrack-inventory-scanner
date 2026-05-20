# PackTrack Inventory Scanner

A browser-based demo for scanning networking equipment into boxes and updating inventory automatically.

## Try It

Run a local server from this folder:

```bash
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

## Scanner Support

- USB and Bluetooth barcode scanners work as keyboard input. Click the scan field and scan an item.
- Manual entry works for testing.
- Camera scanning uses the browser `BarcodeDetector` API when available.

## Demo Barcodes

- `SW-C9300-48P`
- `RTR-ISR4331`
- `SFP-10G-SR`
- `CAB-CAT6-03`
- `PWR-C13-6FT`
