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
  if getent hosts api.trycloudflare.com >/dev/null 2>&1; then
    return 0
  fi
  echo "[!] DNS lijkt kapot in Termux — herstel proberen..."
  printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" > "$PREFIX/etc/resolv.conf" || true
  sleep 1
  if ! getent hosts api.trycloudflare.com >/dev/null 2>&1; then
    echo "[FOUT] DNS werkt nog niet. Zet Android Private DNS op Automatisch/Uit en probeer opnieuw."
    return 1
  fi
  echo "[+] DNS hersteld"
  return 0
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

cleanup() {
  echo ""
  echo "[stop] Alles afsluiten..."
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
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

TUNNEL_LOG=$(mktemp)
cloudflared tunnel --url http://localhost:3001 > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

echo "    Wachten op tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 60); do
  sleep 2
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | grep -v '^https://api\.trycloudflare\.com$' | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[FOUT] Kon tunnel URL niet uitlezen na 2 minuten"
  echo "    Controleer cloudflared output hieronder:"
  tail -n 30 "$TUNNEL_LOG" || true
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
