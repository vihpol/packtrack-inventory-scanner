#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/certs"
MAC_IP="${1:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"

if [[ -z "$MAC_IP" ]]; then
  echo "Could not detect the Mac IP address. Pass it manually, for example:"
  echo "  scripts/setup-local-https.sh 10.0.0.119"
  exit 1
fi

mkdir -p "$CERT_DIR"

cat > "$CERT_DIR/local-server.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names

[alt_names]
DNS.1=localhost
IP.1=127.0.0.1
IP.2=$MAC_IP
EOF

if [[ ! -f "$CERT_DIR/local-root-ca.key" || ! -f "$CERT_DIR/local-root-ca.pem" ]]; then
  openssl genrsa -out "$CERT_DIR/local-root-ca.key" 2048
  openssl req -x509 -new -nodes \
    -key "$CERT_DIR/local-root-ca.key" \
    -sha256 \
    -days 825 \
    -subj "/CN=Scan Demo Local Root CA" \
    -out "$CERT_DIR/local-root-ca.pem"
fi

openssl genrsa -out "$CERT_DIR/local-server.key" 2048
openssl req -new \
  -key "$CERT_DIR/local-server.key" \
  -subj "/CN=$MAC_IP" \
  -out "$CERT_DIR/local-server.csr"
openssl x509 -req \
  -in "$CERT_DIR/local-server.csr" \
  -CA "$CERT_DIR/local-root-ca.pem" \
  -CAkey "$CERT_DIR/local-root-ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/local-server.crt" \
  -days 825 \
  -sha256 \
  -extfile "$CERT_DIR/local-server.ext"

echo "Created local HTTPS certificate for $MAC_IP"
echo "Mac HTTPS URL: https://$MAC_IP:5443"
echo "Phone scanner: https://$MAC_IP:5443/scanner"
echo
echo "Install this certificate on the phone and trust it:"
echo "$CERT_DIR/local-root-ca.pem"
