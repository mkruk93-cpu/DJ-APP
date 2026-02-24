#!/data/data/com.termux/files/usr/bin/bash
#
# One-command setup for Android (Termux):
# - installs required packages
# - ensures storage permission
# - creates/updates .env interactively
# - starts go-live.sh
#
# Usage:
#   bash android-setup-and-run.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "============================================"
echo " Android setup + run (Termux)"
echo "============================================"
echo ""

echo "[1/6] Packages installeren/updaten..."
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs-lts python ffmpeg git curl termux-tools dnsutils openssh >/dev/null 2>&1 || true
pip install -q yt-dlp || true

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[2/6] cloudflared installeren..."
  curl -L -o ~/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
  chmod +x ~/cloudflared
  ln -sf ~/cloudflared "$PREFIX/bin/cloudflared"
else
  echo "[2/6] cloudflared is al geinstalleerd"
fi

echo "[3/6] Storage permissie controleren..."
if [ ! -d "$HOME/storage/shared" ]; then
  termux-setup-storage || true
  echo "    Accepteer storage permissie in Android en run dit script daarna nog 1x."
fi

if [ -f .env ]; then
  echo "[4/6] Bestaande .env gevonden"
  read -r -p "    Wil je .env opnieuw invullen? (j/N): " RESET_ENV
else
  RESET_ENV="y"
fi

if [ "${RESET_ENV:-n}" = "y" ] || [ "${RESET_ENV:-n}" = "Y" ]; then
  echo "[4/6] .env invullen..."

  read -r -p "SUPABASE_URL: " SUPABASE_URL
  read -r -p "SUPABASE_SERVICE_KEY: " SUPABASE_SERVICE_KEY
  read -r -p "ADMIN_TOKEN [Buikspek93.!]: " ADMIN_TOKEN
  read -r -p "FRONTEND_URL [https://krukkex.vercel.app]: " FRONTEND_URL
  read -r -p "FALLBACK_MUSIC_DIR [~/storage/shared/Music/Krukkex Mixes]: " FALLBACK_MUSIC_DIR
  read -r -p "KEEP_FILES [false]: " KEEP_FILES

  ADMIN_TOKEN="${ADMIN_TOKEN:-Buikspek93.!}"
  FRONTEND_URL="${FRONTEND_URL:-https://krukkex.vercel.app}"
  FALLBACK_MUSIC_DIR="${FALLBACK_MUSIC_DIR:-~/storage/shared/Music/Krukkex Mixes}"
  KEEP_FILES="${KEEP_FILES:-false}"

  cat > .env <<EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY

PORT=3001
ADMIN_TOKEN=$ADMIN_TOKEN

CACHE_DIR=/data/data/com.termux/files/home/radio_cache
KEEP_FILES=$KEEP_FILES

ICECAST_HOST=
ICECAST_PORT=
ICECAST_PASSWORD=
ICECAST_MOUNT=

FRONTEND_URL=$FRONTEND_URL

DOWNLOAD_PATH=
REKORDBOX_OUTPUT_PATH=
FALLBACK_MUSIC_DIR=$FALLBACK_MUSIC_DIR
EOF

  echo "    .env opgeslagen"
fi

echo "[5/6] Scripts uitvoerbaar maken..."
chmod +x go-live.sh
mkdir -p /data/data/com.termux/files/home/radio_cache
mkdir -p "$HOME/bin"
cat > "$HOME/bin/radio" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd ~/radio-server/server || exit 1
bash ./go-live.sh
EOF
chmod +x "$HOME/bin/radio"
echo "export PATH=\"$HOME/bin:$PATH\"" > "$HOME/.radio_path_tmp"
if ! grep -q 'HOME/bin' "$HOME/.bashrc" 2>/dev/null; then
  cat "$HOME/.radio_path_tmp" >> "$HOME/.bashrc"
fi
rm -f "$HOME/.radio_path_tmp"

echo "[6/6] Server starten..."
echo ""
bash ./go-live.sh
