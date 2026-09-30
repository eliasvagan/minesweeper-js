#!/usr/bin/env bash
# Runs on the droplet (as root), fed by deploy.sh. Idempotent.
set -euo pipefail
REL=$1
APP=/opt/minesweeper-api
DEST=$APP/releases/$REL
SITE=/etc/nginx/sites-available/eliasv-com
INCLUDE='    include /etc/nginx/snippets/minesweeper-api.conf;'

id minesweeper >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/minesweeper --shell /usr/sbin/nologin minesweeper
install -d -o minesweeper -g minesweeper -m 750 /var/lib/minesweeper /var/backups/minesweeper
if [ ! -f /etc/minesweeper-api.env ]; then
  # Salt for hashing client IPs before they touch the database. Generated once, never printed.
  (umask 077; printf 'IP_SALT=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '/+=')" > /etc/minesweeper-api.env)
fi

cd "$DEST/server"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root "$DEST"
chmod -R u=rwX,go=rX "$DEST"   # root-owned, readable by the service user

PREV=
if [ -L $APP/current ] && [ -d "$(readlink -f $APP/current)" ]; then PREV=$(readlink -f $APP/current); fi
ln -sfn "$DEST" $APP/current.new && mv -T $APP/current.new $APP/current

install -m 644 deploy/minesweeper-api.service deploy/minesweeper-backup.service deploy/minesweeper-backup.timer /etc/systemd/system/
cat > /usr/local/bin/minesweeper-admin <<'SH'
#!/bin/sh
# Leaderboard maintenance as the service user:  minesweeper-admin counts | purge-player <pid> | backup <dir>
cd /opt/minesweeper-api/current/server && exec runuser -u minesweeper -- env DB_PATH=/var/lib/minesweeper/scores.db /usr/bin/node admin.js "$@"
SH
chmod 755 /usr/local/bin/minesweeper-admin
systemctl daemon-reload
systemctl enable --now minesweeper-backup.timer >/dev/null
systemctl enable minesweeper-api >/dev/null
systemctl restart minesweeper-api

ok=
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  if curl -fsS http://127.0.0.1:3890/health >/dev/null 2>&1; then ok=1; break; fi
done
if [ -z "$ok" ]; then
  echo "health check failed" >&2; journalctl -u minesweeper-api -n 20 --no-pager >&2
  if [ -n "$PREV" ] && [ "$PREV" != "$DEST" ]; then ln -sfn "$PREV" $APP/current; systemctl restart minesweeper-api; echo "rolled back to $PREV" >&2; fi
  exit 1
fi

# nginx: the snippet, included once inside the certbot-managed 443 block (before its catch-all location).
install -m 644 deploy/nginx-minesweeper-api.conf /etc/nginx/snippets/minesweeper-api.conf
changed=
if ! grep -qF 'snippets/minesweeper-api.conf' $SITE; then
  changed=1
  cp -p $SITE /root/eliasv-com.nginx.bak
  awk -v inc="$INCLUDE" '!done && /^    location \/ \{/ { print inc; print ""; done=1 } { print }' /root/eliasv-com.nginx.bak > $SITE
fi
if nginx -t 2>/dev/null; then
  systemctl reload nginx
else
  nginx -t || true
  [ -n "$changed" ] && cp -p /root/eliasv-com.nginx.bak $SITE && nginx -t && echo "nginx change reverted" >&2
  exit 1
fi

# Keep the three newest releases.
ls -1dt $APP/releases/* | tail -n +4 | while read -r old; do [ "$old" != "$(readlink -f $APP/current)" ] && rm -rf "$old"; done
echo "live: $(curl -fsS http://127.0.0.1:3890/health) release $REL"
