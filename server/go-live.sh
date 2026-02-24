#!/data/data/com.termux/files/usr/bin/bash
#
# go-live.sh — Start the radio server + Cloudflare tunnel on Android (Termux)
# Equivalent of "Go Live.bat" Radio Mode on Windows.
#
# Usage: bash go-live.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ensure_dns() {
  if command -v getent >/dev/null 2>&1 && getent hosts api.trycloudflare.com >/dev/null 2>&1; then
    return 0
  fi
  if command -v nslookup >/dev/null 2>&1 && nslookup api.trycloudflare.com >/dev/null 2>&1; then
    return 0
  fi
  echo "[!] DNS lijkt kapot in Termux — herstel proberen..."
  printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" > "$PREFIX/etc/resolv.conf" || true
  sleep 1
  if command -v getent >/dev/null 2>&1 && getent hosts api.trycloudflare.com >/dev/null 2>&1; then
    echo "[+] DNS hersteld"
    return 0
  fi
  if command -v nslookup >/dev/null 2>&1 && nslookup api.trycloudflare.com >/dev/null 2>&1; then
    echo "[+] DNS hersteld"
    return 0
  fi
  if ! ping -c 1 -W 2 api.trycloudflare.com >/dev/null 2>&1; then
    echo "[FOUT] DNS werkt nog niet. Zet Android Private DNS op Automatisch/Uit en probeer opnieuw."
    return 1
  fi
  echo "[+] DNS hersteld"
  return 0
}

extract_url_from_log() {
  local log_file="$1"
  grep -oE 'https://[A-Za-z0-9._/-]+' "$log_file" 2>/dev/null | head -1
}

normalize_url() {
  local url="$1"
  url="${url%%/}"
  echo "$url"
}

extract_cloudflare_url() {
  local log_file="$1"
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log_file" 2>/dev/null | head -1
}

extract_localhostrun_url() {
  local log_file="$1"
  grep -oE 'https://[A-Za-z0-9-]+\.localhost\.run' "$log_file" 2>/dev/null \
    | grep -vE '^https://admin\.localhost\.run$' \
    | head -1
}

extract_pinggy_url() {
  local log_file="$1"
  grep -oE 'https://[A-Za-z0-9.-]*pinggy\.(link|io)' "$log_file" 2>/dev/null | head -1
}

start_tunnel_cloudflare() {
  echo "    Tunnel provider: Cloudflare quick tunnel"
  TUNNEL_LOG=$(mktemp)
  cloudflared tunnel --url http://localhost:3001 > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for i in $(seq 1 10); do
    sleep 2
    TUNNEL_URL=$(extract_cloudflare_url "$TUNNEL_LOG")
    if [ -n "$TUNNEL_URL" ]; then
      TUNNEL_URL=$(normalize_url "$TUNNEL_URL")
      return 0
    fi
  done

  kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  TUNNEL_PID=""
  rm -f "$TUNNEL_LOG"
  TUNNEL_LOG=""
  return 1
}

start_tunnel_localhostrun() {
  echo "    Tunnel provider: localhost.run (fallback)"
  if ! command -v ssh >/dev/null 2>&1; then
    return 1
  fi
  TUNNEL_LOG=$(mktemp)
  ssh -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=30 \
    -o ExitOnForwardFailure=yes \
    -N -R 80:localhost:3001 nokey@localhost.run > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for i in $(seq 1 20); do
    sleep 2
    TUNNEL_URL=$(extract_localhostrun_url "$TUNNEL_LOG")
    if [ -n "$TUNNEL_URL" ]; then
      TUNNEL_URL=$(normalize_url "$TUNNEL_URL")
      return 0
    fi
  done

  kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  TUNNEL_PID=""
  rm -f "$TUNNEL_LOG"
  TUNNEL_LOG=""
  return 1
}

start_tunnel_pinggy() {
  echo "    Tunnel provider: pinggy (fallback)"
  if ! command -v ssh >/dev/null 2>&1; then
    return 1
  fi
  TUNNEL_LOG=$(mktemp)
  ssh -p 443 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=30 \
    -o ExitOnForwardFailure=yes \
    -N -R0:localhost:3001 a.pinggy.io > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for i in $(seq 1 20); do
    sleep 2
    TUNNEL_URL=$(extract_pinggy_url "$TUNNEL_LOG")
    if [ -n "$TUNNEL_URL" ]; then
      TUNNEL_URL=$(normalize_url "$TUNNEL_URL")
      return 0
    fi
  done

  kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  TUNNEL_PID=""
  rm -f "$TUNNEL_LOG"
  TUNNEL_LOG=""
  return 1
}

# ── Read ADMIN_TOKEN from .env ──

ADMIN_TOKEN=""
if [ -f .env ]; then
  ADMIN_TOKEN=$(grep -E '^ADMIN_TOKEN=' .env | cut -d'=' -f2- | tr -d '\r')
fi

if [ -z "$ADMIN_TOKEN" ]; then
  echo "[FOUT] Geen ADMIN_TOKEN gevonden in .env"
  exit 1
fi

# ── Cleanup on exit ──

SERVER_PID=""
TUNNEL_PID=""
TUNNEL_LOG=""
TUNNEL_URL=""

cleanup() {
  echo ""
  echo "[stop] Alles afsluiten..."
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG" 2>/dev/null
  exit 0
}

trap cleanup INT TERM

# ── Termux wake lock (prevent Android from killing the process) ──

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "[+] Termux wake-lock geactiveerd"
fi

# ── Start the server ──

echo ""
echo "============================================"
echo "     Radio Server starten (Termux)..."
echo "============================================"
echo ""

# Stop leftovers from previous runs so port 3001 is always free.
pkill -f "tsx src/server.ts" >/dev/null 2>&1 || true
pkill -f "cloudflared tunnel --url http://localhost:3001" >/dev/null 2>&1 || true

echo "[+] Server starten..."
npx tsx src/server.ts &
SERVER_PID=$!
echo "    PID: $SERVER_PID"

echo "    Wachten tot server klaar is..."
READY=0
for i in $(seq 1 30); do
  sleep 1
  if curl -s -o /dev/null -w "" http://localhost:3001/health 2>/dev/null; then
    READY=1
    break
  fi
done

if [ "$READY" -eq 0 ]; then
  echo "[FOUT] Server niet gestart na 30 seconden"
  cleanup
  exit 1
fi
echo "    OK — server draait"

# ── Start Cloudflare tunnel ──

echo "[+] Cloudflare Tunnel starten..."
ensure_dns || exit 1

echo "    Wachten op tunnel URL..."
if ! start_tunnel_cloudflare; then
  echo "    Cloudflare quick tunnel mislukt, fallback starten..."
  if ! start_tunnel_localhostrun; then
    echo "    localhost.run mislukt, tweede fallback starten..."
    start_tunnel_pinggy || true
  fi
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "[FOUT] Kon tunnel URL niet ophalen via alle providers"
  echo "    Controleer cloudflared output hieronder:"
  [ -n "$TUNNEL_LOG" ] && tail -n 30 "$TUNNEL_LOG" || true
  rm -f "$TUNNEL_LOG"
  cleanup
  exit 1
fi

echo "    Tunnel URL: $TUNNEL_URL"
rm -f "$TUNNEL_LOG"

# ── Save tunnel URL to server/Supabase ──

echo "    Opslaan in database..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3001/api/tunnel-url \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$TUNNEL_URL\",\"token\":\"$ADMIN_TOKEN\"}" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  echo "    OK — URL opgeslagen via server"
else
  echo "    Server response: $HTTP_CODE — probeer direct Supabase..."
  SUPABASE_URL=$(grep -E '^SUPABASE_URL=' .env | cut -d'=' -f2- | tr -d '\r')
  SUPABASE_KEY=$(grep -E '^SUPABASE_SERVICE_KEY=' .env | cut -d'=' -f2- | tr -d '\r')
  if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]; then
    curl -s -o /dev/null \
      -X PATCH "${SUPABASE_URL}/rest/v1/settings?id=eq.1" \
      -H "apikey: $SUPABASE_KEY" \
      -H "Authorization: Bearer $SUPABASE_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"radio_server_url\":\"$TUNNEL_URL\"}"
    echo "    OK — URL opgeslagen via Supabase"
  else
    echo "    [FOUT] Supabase credentials niet gevonden in .env"
  fi
fi

# ── Running ──

echo ""
echo "============================================"
echo "  Radio server draait!"
echo ""
echo "  Server:  http://localhost:3001"
echo "  Tunnel:  $TUNNEL_URL"
echo "  Stream:  $TUNNEL_URL/listen"
echo ""
echo "  Druk Ctrl+C om alles te stoppen"
echo "============================================"
echo ""

# Wait for server process (keeps script alive)
wait $SERVER_PID
