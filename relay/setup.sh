#!/usr/bin/env bash
# One-step setup of the Bid Assistant relay on a Linux VPS.
#   sudo bash setup.sh
# Installs Node.js if missing, runs the relay as a service (auto-start on boot),
# opens the port, and prints the PAIRING CODE to paste into B1 and B2.
set -e
PORT="${PORT:-8787}"
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"

if [ "$(id -u)" != "0" ]; then echo "Please run with sudo:  sudo bash $0"; exit 1; fi

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js…"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq nodejs
  elif command -v dnf >/dev/null; then dnf install -y -q nodejs
  elif command -v yum >/dev/null; then yum install -y -q nodejs
  else echo "Install Node.js manually, then run this again."; exit 1; fi
fi

# secret token (kept across re-runs)
if [ ! -s "$DIR/token.txt" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DIR/token.txt"
fi
chown "$RUN_USER" "$DIR/token.txt"; chmod 600 "$DIR/token.txt"
TOKEN="$(cat "$DIR/token.txt")"

cat > /etc/systemd/system/bid-relay.service <<UNIT
[Unit]
Description=Bid Assistant relay
After=network.target

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.js
Environment=PORT=$PORT
Restart=always
User=$RUN_USER

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bid-relay >/dev/null 2>&1
systemctl restart bid-relay

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT/tcp" >/dev/null; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --add-port="$PORT/tcp" --permanent >/dev/null && firewall-cmd --reload >/dev/null
fi

IP="$(curl -s --max-time 5 https://api.ipify.org || true)"
[ -z "$IP" ] && IP="$(hostname -I | awk '{print $1}')"

sleep 1
if systemctl is-active --quiet bid-relay; then
  echo
  echo "✓ Relay is running (starts automatically on reboot)."
  echo
  echo "  PAIRING CODE:   $IP:$PORT/$TOKEN"
  echo
  echo "Paste this code into the B1 popup (here on the VPS) and the B2 popup (your PC)."
  echo "If your VPS provider has its own firewall / security group, allow TCP port $PORT there."
else
  echo "✗ Relay did not start. See: journalctl -u bid-relay -n 30"; exit 1
fi
