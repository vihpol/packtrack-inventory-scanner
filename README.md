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

## Run as a Mac Server

Install the macOS LaunchAgent once:

```bash
mkdir -p ~/Library/LaunchAgents
cp mac/com.vihpol.scandemo.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vihpol.scandemo.plist
launchctl kickstart -k gui/$(id -u)/com.vihpol.scandemo
```

After that, the Mac starts the server automatically when you log in. The Mac dashboard is:

```text
http://localhost:5173
```

The phone client can use your Mac's local network address:

```text
http://YOUR_MAC_IP:5173/scanner
```

Phone camera scanning may still require HTTPS, depending on the phone browser. For camera access, use an HTTPS tunnel or deploy the app with HTTPS.

### Local HTTPS for Phone Camera

Create a local HTTPS certificate:

```bash
chmod +x scripts/setup-local-https.sh
scripts/setup-local-https.sh
```

Restart the Mac server:

```bash
launchctl kickstart -k gui/$(id -u)/com.vihpol.scandemo
```

The local HTTPS scanner URL will look like:

```text
https://YOUR_MAC_IP:5443/scanner
```

To make the phone trust it, install `certs/local-root-ca.pem` on the phone and enable full trust for that certificate in the phone settings.

The barcode scanner library is vendored in `vendor/html5-qrcode.min.js`, so the scanner page does not need a CDN at runtime.

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
- Phone camera testing uses the stripped-down `/scanner` page with only a Camera button and scan result.
- QR-code URL scans still work with `/scan?barcode=YOUR_REAL_BARCODE`.
- You can force a phone scan direction with `/scan?mode=incoming&barcode=...` or `/scan?mode=outgoing&barcode=...`.

## Phone Camera Test

Open the phone scanner at:

```text
http://localhost:5173/scanner
```

For phone testing, expose the local server with an HTTPS tunnel:

```bash
npx localtunnel --port 5173
```

Use the `https://...` URL from localtunnel with `/scanner` at the end.

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
