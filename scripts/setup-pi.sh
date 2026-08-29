#!/usr/bin/env bash
# HTM Room Control — Raspberry Pi setup script
# Run once from the repo root: bash scripts/setup-pi.sh
set -e

BRANCH="${BRANCH:-m1-implementation}"
REPO="https://github.com/hourtomidnight/htm-room-control"
INSTALL_DIR="$HOME/htm-room-control"
SERVICE_NAME="htm-room-control"

echo ""
echo "=================================================="
echo "  HTM Room Control — Pi Setup"
echo "=================================================="
echo ""

# ── Node.js check (need >= 22) ───────────────────────────────────────────────
NODE_OK=0
if command -v node &>/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 22 ] && NODE_OK=1
fi
if [ "$NODE_OK" -ne 1 ]; then
  echo "[!] Node.js 22+ not found. Installing Node 22 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node.js  $(node -v)   OK"

# ── Git check ───────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  echo "[!] Git not found. Installing..."
  sudo apt-get install -y git
fi
echo "  Git      $(git --version | awk '{print $3}')   OK"

# ── Clone or update repo ────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ""
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
else
  echo ""
  echo "  Cloning repository..."
  git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
echo ""
echo "  Repository up to date at $INSTALL_DIR"

# ── Install runtime dependencies (googleapis only) ──────────────────────────
echo ""
echo "  Installing npm runtime dependencies (--omit=dev)..."
cd "$INSTALL_DIR"
npm install --omit=dev

# ── Assets reminder ────────────────────────────────────────────────────────
echo ""
echo "  Audio assets needed in: $INSTALL_DIR/public/assets/"
echo "    TimerMusic.mp3   FinaleMusic.mp3   ClueSound.mp3"
echo "  (App runs without them — audio commands are silent)"

# ── Google Sheets credentials reminder ─────────────────────────────────────
echo ""
if [ ! -f "$INSTALL_DIR/google-credentials.json" ]; then
  echo "  [!] No google-credentials.json found — Sheets mirroring is disabled until"
  echo "      you copy a service-account key to:"
  echo "        $INSTALL_DIR/google-credentials.json"
  echo "      Then set the spreadsheet IDs/tab names at http://<pi>/room-control/config.html"
fi
if [ ! -f "$INSTALL_DIR/config.json" ]; then
  echo "  [!] No config.json yet — run 'npm run migrate-config -- /path/to/old/config.json ./config.json'"
  echo "      or start fresh and configure at http://<pi>/room-control/config.html"
fi

# ── systemd units (Node process + kiosk display) ───────────────────────────
echo ""
echo "  Installing systemd units..."
sudo cp deploy/htm-room-control.service /etc/systemd/system/
sudo cp deploy/htm-room-control-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now htm-room-control
sudo systemctl enable htm-room-control-kiosk   # starts with the graphical target
echo "  Services enabled. Manage with:"
echo "    sudo systemctl status  $SERVICE_NAME"
echo "    sudo systemctl restart $SERVICE_NAME"
echo "    journalctl -u $SERVICE_NAME -f"

# ── nginx integration ──────────────────────────────────────────────────────
echo ""
SNIPPET_DEST="/etc/nginx/snippets/htm-room-control.conf"
read -r -p "  Add /room-control/ to nginx (integrates with your existing site)? [Y/n] " INSTALL_NGINX
if [[ ! "$INSTALL_NGINX" =~ ^[Nn]$ ]]; then
  if ! command -v nginx &>/dev/null; then
    echo "  Installing nginx..."
    sudo apt-get install -y nginx
  fi

  sudo mkdir -p /etc/nginx/snippets
  sudo cp "$INSTALL_DIR/deploy/nginx-htm.conf" "$SNIPPET_DEST"
  echo "  Snippet installed to $SNIPPET_DEST"

  # Find the active nginx server block file
  NGINX_SITE=""
  for f in /etc/nginx/sites-enabled/*; do
    if sudo grep -q "listen 80" "$f" 2>/dev/null; then
      NGINX_SITE="$f"
      break
    fi
  done

  if [ -n "$NGINX_SITE" ]; then
    if sudo grep -q "htm-room-control" "$NGINX_SITE"; then
      echo "  Snippet already included in $NGINX_SITE"
    else
      echo "  [!] Add this line inside your server {} block in $NGINX_SITE:"
      echo "        include $SNIPPET_DEST;"
    fi
  else
    echo "  No existing nginx site found on port 80."
    echo "  Add this line inside your server {} block:"
    echo "        include $SNIPPET_DEST;"
  fi

  sudo nginx -t && sudo systemctl reload nginx
  echo "  nginx reloaded."
else
  echo "  Skipped nginx. App accessible on port 4000 only."
fi

# ── Print access URLs ──────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I | awk '{print $1}')
HNAME=$(hostname)
echo ""
echo "=================================================="
echo "  Setup complete!"
echo ""
if [[ ! "$INSTALL_NGINX" =~ ^[Nn]$ ]]; then
  echo "  Room Control sub-page:"
  echo "    http://${HNAME}.local/room-control/"
  echo "    http://${LOCAL_IP}/room-control/"
else
  echo "  Access from any device on your network:"
  echo "    http://${HNAME}.local:4000/"
  echo "    http://${LOCAL_IP}:4000/"
fi
echo ""
echo "  Health:  curl http://localhost:4000/healthz"
echo "=================================================="
echo ""
