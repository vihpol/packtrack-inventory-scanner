# Product Scan Inventory Demo

A minimal three-column demo where barcode/QR scans update inventory, incoming receipts, and outgoing inventory.

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
2. Manually create an inventory entry, or scan a brand-new barcode.
3. A new barcode is treated as incoming inventory and creates an inventory row.
4. Scanning an existing barcode through `/scan?barcode=YOUR_REAL_BARCODE` treats it as outgoing inventory and decreases quantity.
5. The dashboard updates the Inventory list, Incoming inventory, and Outgoing inventory columns.

## Scanner Support

- The Mac page is an inventory dashboard with three columns.
- Use the Create entry form to manually add barcode, description, cost, and quantity.
- Use the Incoming inventory form to receive new or existing products.
- Use the Outgoing inventory form to sell, ship, or return existing products.
- Incoming and outgoing logs show when each scan happened.
- Phone camera testing works by scanning a QR code that opens `/scan?barcode=YOUR_REAL_BARCODE`.
- You can force a phone scan direction with `/scan?mode=incoming&barcode=...` or `/scan?mode=outgoing&barcode=...`.

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
