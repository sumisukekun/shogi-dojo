#!/usr/bin/env bash
# 将棋オンライン道場 かんたん設置スクリプト
# 使い方（サーバーで root として1行）:
#   curl -fsSL https://raw.githubusercontent.com/sumisukekun/shogi-dojo/main/deploy/setup.sh | bash
# ドメインを使う場合（HTTPS も自動設定）:
#   curl -fsSL https://raw.githubusercontent.com/sumisukekun/shogi-dojo/main/deploy/setup.sh | DOMAIN=shogi.example.com EMAIL=you@example.com bash
# 何度実行しても大丈夫（更新にも使える）。
set -euo pipefail

REPO="https://github.com/sumisukekun/shogi-dojo.git"
APP_DIR="/opt/shogi-dojo"
APP_USER="shogi"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "root で実行してください（sudo -i してから再実行）"; exit 1; }

# ---- OS 判定 ----
if command -v apt-get >/dev/null; then PM=apt
elif command -v dnf >/dev/null; then PM=dnf
else echo "対応していないOSです（Ubuntu / Debian / Rocky / Alma に対応）"; exit 1; fi
say "OS: $(. /etc/os-release; echo "$PRETTY_NAME")"

# ---- 必要なソフト ----
say "必要なソフトを入れています（数分かかります）"
if [ $PM = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl git nginx ca-certificates
else
  dnf install -y curl git nginx ca-certificates tar
fi

NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
NODE_MINOR=$(node -v 2>/dev/null | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  say "Node.js 22 を入れています"
  if [ $PM = apt ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs
  else curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -; dnf install -y nodejs; fi
fi
say "Node.js $(node -v)"

# ---- アプリ本体 ----
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  say "最新版に更新しています"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  say "プログラムを取得しています"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
git config --global --add safe.directory "$APP_DIR" || true
( cd "$APP_DIR" && runuser -u "$APP_USER" -- npm install --omit=dev --no-audit --no-fund )

# ---- ポート（空いている番号を使う） ----
PORT=""
if [ -f /etc/systemd/system/shogi-dojo.service ]; then
  PORT=$(sed -nE 's/^Environment=PORT=([0-9]+)/\1/p' /etc/systemd/system/shogi-dojo.service || true)
fi
if [ -z "$PORT" ]; then
  for p in 3000 3100 3200 3300 8300; do
    if ! ss -ltn "( sport = :$p )" | grep -q ":$p"; then PORT=$p; break; fi
  done
fi
say "アプリのポート: $PORT"

# ---- 常駐（自動起動） ----
cat > /etc/systemd/system/shogi-dojo.service <<UNIT
[Unit]
Description=Shogi Online Dojo
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=NODE_ENV=production
ExecStart=$(command -v node) server/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable shogi-dojo >/dev/null 2>&1
systemctl restart shogi-dojo

# ---- nginx（Web公開・WebSocket対応） ----
IP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
NAMES="$IP"; [ -n "$DOMAIN" ] && NAMES="$DOMAIN $IP"
if [ -d /etc/nginx/sites-available ]; then
  CONF=/etc/nginx/sites-available/shogi-dojo
  ln -sf "$CONF" /etc/nginx/sites-enabled/shogi-dojo
else
  CONF=/etc/nginx/conf.d/shogi-dojo.conf
fi
cat > "$CONF" <<NGX
map \$http_upgrade \$shogi_conn { default upgrade; '' close; }
server {
  listen 80;
  listen [::]:80;
  server_name $NAMES;
  client_max_body_size 1m;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$shogi_conn;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
  }
}
NGX
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx

# ---- サーバー内のファイアウォール ----
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http --add-service=https; firewall-cmd --reload
fi
if command -v getenforce >/dev/null && [ "$(getenforce)" = Enforcing ]; then setsebool -P httpd_can_network_connect 1 || true; fi

# ---- HTTPS（ドメインがある場合） ----
if [ -n "$DOMAIN" ]; then
  say "HTTPS を設定しています（$DOMAIN）"
  if [ $PM = apt ]; then apt-get install -y certbot python3-certbot-nginx; else dnf install -y certbot python3-certbot-nginx; fi
  if [ -n "$EMAIL" ]; then certbot --nginx -n --agree-tos -m "$EMAIL" -d "$DOMAIN" --redirect
  else certbot --nginx -n --agree-tos --register-unsafely-without-email -d "$DOMAIN" --redirect; fi
fi

# ---- 確認 ----
sleep 2
say "動作確認"
if curl -fsS "http://127.0.0.1:$PORT/health"; then
  echo
  echo "============================================"
  echo " 設置完了！ ブラウザで開いてください:"
  echo "   http://$IP/"
  [ -n "$DOMAIN" ] && echo "   https://$DOMAIN/"
  echo "============================================"
else
  echo "起動に失敗しました。次のコマンドの結果を Claude に送ってください:"
  echo "  journalctl -u shogi-dojo -n 50 --no-pager"
fi
