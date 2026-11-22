#!/bin/bash
# Uji browser lintas-origin. Butuh: python3 + playwright (pip install playwright && playwright install chromium)
cd "$(dirname "$0")/.."
SITE_DIR=$(mktemp -d)
cp index.html app.js dominoLogic.js demoData.js favicon.svg google-apps-script.js "$SITE_DIR/"
API="http://127.0.0.1:4951/functions/v1/api"
printf 'window.DOMINO_CONFIG = { API_URL: "%s" };\n' "$API" > "$SITE_DIR/config.js"
cleanup() { kill $PIDS 2>/dev/null; rm -rf "$SITE_DIR"; }
PIDS=""; trap cleanup EXIT
python3 -m http.server 4950 --directory "$SITE_DIR" --bind 127.0.0.1 > /dev/null 2>&1 & PIDS="$PIDS $!"
MOCK_PORT=5401 node test/mock-postgrest.mjs > /dev/null 2>&1 & PIDS="$PIDS $!"
sleep 0.7
run_edge() { PORT=4951 SUPABASE_URL=http://127.0.0.1:5401 SUPABASE_SERVICE_ROLE_KEY=test-service-key FORCE_PASSWORD=CURANGDOSA ALLOWED_ORIGIN="$1" node test/edge-harness.mjs > /dev/null 2>&1 & EP=$!; PIDS="$PIDS $EP"; sleep 1.5; }
echo "=== Skenario 1: ALLOWED_ORIGIN = alamat tampilan (harus berfungsi)"
run_edge "http://127.0.0.1:4950"
timeout 120 python3 test/e2e-browser.py; R1=$?
kill $EP; sleep 0.5
echo "=== Skenario 2: ALLOWED_ORIGIN = alamat lain (browser harus memblokir)"
run_edge "https://bukan-situs-kami.example"
EXPECT_CORS_BLOCK=1 timeout 120 python3 test/e2e-browser.py; R2=$?
# skenario 2 melaporkan exit 0 bila pemblokiran terdeteksi benar
exit $(( R1 != 0 || R2 != 0 ))
