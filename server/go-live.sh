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

read_env() {
  local key="$1"
  [ -f .env ] || return 0
  grep -E "^${key}=" .env | cut -d'=' -f2- | tr -d '\r' | head -1
}

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
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log_file" 2>/dev/null \
    | grep -vE '^https://api\.trycloudflare\.com$' \
    | head -1
}

extract_localhostrun_url() {
  local log_file="$1"
  local lhr_url
  lhr_url=$(grep -oE 'https://[A-Za-z0-9.-]+\.lhr\.life' "$log_file" 2>/dev/null | head -1)
  if [ -n "$lhr_url" ]; then
    echo "$lhr_url"
    return 0
  fi

  grep -oE 'https://[A-Za-z0-9-]+\.localhost\.run' "$log_file" 2>/dev/null \
    | grep -vE '^https://(admin|www)\.localhost\.run$' \
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

start_tunnel_named() {
  local token="$1"
  local public_url="$2"
  echo "    Tunnel provider: Cloudflare named tunnel"
  TUNNEL_LOG=$(mktemp)
  cloudflared tunnel --no-autoupdate run --token "$token" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for i in $(seq 1 20); do
    sleep 1
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      break
    fi
  done

  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "    Named tunnel startte niet goed:"
    tail -n 30 "$TUNNEL_LOG" || true
    rm -f "$TUNNEL_LOG"
    TUNNEL_LOG=""
    TUNNEL_PID=""
    return 1
  fi

  TUNNEL_URL=$(normalize_url "$public_url")
  return 0
}

start_tunnel_ngrok() {
  echo "    Tunnel provider: ngrok"
  if ! command -v ngrok >/dev/null 2>&1; then
    return 1
  fi

  if [ -n "$NGROK_AUTHTOKEN" ]; then
    ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1 || true
  fi

  TUNNEL_LOG=$(mktemp)
  ngrok http 3001 --log=stdout > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for i in $(seq 1 25); do
    sleep 1
    TUNNEL_URL=$(
      curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
        | python -c "import sys,json
try:
 d=json.load(sys.stdin)
 print(next((t.get('public_url','') for t in d.get('tunnels',[]) if str(t.get('public_url','')).startswith('https://')), ''))
except Exception:
 print('')" 2>/dev/null
    )
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
  # Use the exact command that worked manually for this device/network.
  ssh -o StrictHostKeyChecking=no -N -R 80:localhost:3001 nokey@localhost.run > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for i in $(seq 1 45); do
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
    -o BatchMode=yes \
    -o PasswordAuthentication=no \
    -o NumberOfPasswordPrompts=0 \
    -o ConnectTimeout=10 \
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

ADMIN_TOKEN="$(read_env ADMIN_TOKEN)"
NAMED_TUNNEL_TOKEN="$(read_env CLOUDFLARED_TUNNEL_TOKEN)"
NAMED_TUNNEL_URL="$(read_env RADIO_SERVER_URL)"
NGROK_AUTHTOKEN="$(read_env NGROK_AUTHTOKEN)"
TUNNEL_MODE="$(read_env TUNNEL_MODE)"
if [ -z "$TUNNEL_MODE" ]; then
  TUNNEL_MODE="ssh"
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
pkill -f "cloudflared tunnel" >/dev/null 2>&1 || true
pkill -f "ngrok http 3001" >/dev/null 2>&1 || true

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

echo "    Wachten op tunnel URL..."
if [ "$TUNNEL_MODE" = "ssh" ]; then
  echo "[+] SSH tunnel mode actief (zonder Cloudflare/ngrok)..."
  if ! start_tunnel_localhostrun; then
    echo "    localhost.run mislukt, tweede SSH fallback starten..."
    start_tunnel_pinggy || true
  fi
else
  echo "[+] Auto tunnel mode actief (named/ngrok/cloudflare + ssh fallback)..."
  ensure_dns || true
  if [ -n "$NAMED_TUNNEL_TOKEN" ]; then
    if [ -z "$NAMED_TUNNEL_URL" ]; then
      echo "[FOUT] CLOUDFLARED_TUNNEL_TOKEN is gezet, maar RADIO_SERVER_URL ontbreekt in .env"
      echo "       Zet bv: RADIO_SERVER_URL=https://radio.jouwdomein.nl"
      cleanup
      exit 1
    fi
    start_tunnel_named "$NAMED_TUNNEL_TOKEN" "$NAMED_TUNNEL_URL" || {
      echo "    Named tunnel mislukt, quick/fallback proberen..."
      if ! start_tunnel_cloudflare; then
        echo "    Cloudflare quick tunnel mislukt, fallback starten..."
        if ! start_tunnel_localhostrun; then
          echo "    localhost.run mislukt, tweede fallback starten..."
          start_tunnel_pinggy || true
        fi
      fi
    }
  else
    if [ -n "$NGROK_AUTHTOKEN" ]; then
      if ! start_tunnel_ngrok; then
        echo "    ngrok mislukt, cloudflare/fallback proberen..."
        if ! start_tunnel_cloudflare; then
          echo "    Cloudflare quick tunnel mislukt, fallback starten..."
          if ! start_tunnel_localhostrun; then
            echo "    localhost.run mislukt, tweede fallback starten..."
            start_tunnel_pinggy || true
          fi
        fi
      fi
    else
      if ! start_tunnel_cloudflare; then
        echo "    Cloudflare quick tunnel mislukt, fallback starten..."
        if ! start_tunnel_localhostrun; then
          echo "    localhost.run mislukt, tweede fallback starten..."
          if ! start_tunnel_pinggy; then
            echo "    pinggy mislukt, ngrok proberen..."
            start_tunnel_ngrok || true
          fi
        fi
      fi
    fi
  fi
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "[FOUT] Kon tunnel URL niet ophalen via alle providers"
  echo "    Controleer tunnel output hieronder:"
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
