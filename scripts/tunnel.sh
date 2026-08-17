#!/usr/bin/env bash
#
# PUBLIC LINK VIA CLOUDFLARE QUICK TUNNELS
# ========================================
# Puts a shareable https:// URL in front of the local arcade. No Cloudflare
# account, no domain, no DNS — `cloudflared tunnel --url` hands out a
# throwaway *.trycloudflare.com hostname per run.
#
# WHY TWO TUNNELS
# ---------------
# The browser talks to the API directly (lib/api.ts fetches BASE_URL, and
# the game socket dials the same host). Tunnelling only the frontend gives
# a page that loads and then fails every request, because `localhost:3002`
# resolves on the VISITOR's machine, not on yours. So the API gets its own
# tunnel and the frontend is told where it lives.
#
# THE ORDERING THAT MAKES IT WORK
# -------------------------------
# Both tunnels come up FIRST, before anything is listening on the ports
# they point at — cloudflared does not care, and it is the only way to
# break the circular dependency:
#
#   the web build needs the API's public URL   (VITE_API_URL is baked in
#                                               at build time, not read at
#                                               runtime)
#   the API needs the web's public origin      (CLIENT_ORIGIN drives the
#                                               CORS allowlist AND the
#                                               socket engine's
#                                               allowRequest — an origin
#                                               that is not on it gets no
#                                               CORS headers and no
#                                               websocket upgrade)
#
# The frontend is served as a PRODUCTION BUILD via `vite preview`, not the
# dev server: a dev server ships hundreds of unbundled modules, and over a
# tunnel that is painfully slow.
#
#   ./scripts/tunnel.sh          start everything, print the link
#   ./scripts/tunnel.sh stop     tear it all down
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.tunnel"
API_PORT="${API_PORT:-3002}"
WEB_PORT="${WEB_PORT:-4173}"

mkdir -p "$RUN_DIR"

stop() {
  echo "Stopping…"
  for name in api-tunnel web-tunnel api web; do
    local pidfile="$RUN_DIR/$name.pid"
    if [[ -f "$pidfile" ]]; then
      local pid
      pid="$(cat "$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then
        # Negative pid kills the whole process group: `bun run`/`vite`
        # spawn children that would otherwise keep the ports bound.
        kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        echo "  stopped $name (pid $pid)"
      fi
      rm -f "$pidfile"
    fi
  done
  # Belt and braces for anything left holding the ports.
  lsof -ti "tcp:$API_PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
  lsof -ti "tcp:$WEB_PORT" 2>/dev/null | xargs -r kill 2>/dev/null || true
  echo "Done."
}

if [[ "${1:-start}" == "stop" ]]; then
  stop
  exit 0
fi

command -v cloudflared >/dev/null || { echo "cloudflared is not installed — brew install cloudflared"; exit 1; }
command -v doppler    >/dev/null || { echo "doppler is not installed — the server needs its secrets"; exit 1; }

stop >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 1. Both tunnels, before anything is listening
# ---------------------------------------------------------------------------
start_tunnel() {
  local name="$1" port="$2" log="$RUN_DIR/$1.log"
  : > "$log"
  # setsid so the tunnel gets its own process group and survives this shell.
  nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$port" \
    > "$log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
}

grab_url() {
  local log="$RUN_DIR/$1.log" url="" i
  for ((i = 0; i < 60; i++)); do
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null | head -1 || true)"
    [[ -n "$url" ]] && { echo "$url"; return 0; }
    sleep 1
  done
  echo "Timed out waiting for the $1 URL. Log:" >&2
  tail -20 "$log" >&2
  return 1
}

echo "Opening tunnels…"
start_tunnel api-tunnel "$API_PORT"
start_tunnel web-tunnel "$WEB_PORT"

API_URL="$(grab_url api-tunnel)"
WEB_URL="$(grab_url web-tunnel)"
echo "  api → $API_URL"
echo "  web → $WEB_URL"

# ---------------------------------------------------------------------------
# 2. API, told which origin to trust
# ---------------------------------------------------------------------------
# CLIENT_ORIGIN is read by isAllowedOrigin() in apps/server/src/index.ts,
# which gates BOTH the HTTP CORS headers and the socket handshake. Localhost
# stays allowed regardless (the predicate always permits loopback), so this
# does not disturb local development.
echo "Starting the API…"
cd "$ROOT/apps/server"
CLIENT_ORIGIN="$WEB_URL" PORT="$API_PORT" \
  nohup doppler run -- bun run src/index.ts > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

# ---------------------------------------------------------------------------
# 3. Frontend, built against the API's public URL
# ---------------------------------------------------------------------------
echo "Building the frontend against $API_URL …"
cd "$ROOT/apps/web"
VITE_API_URL="$API_URL" doppler run -- bun run build > "$RUN_DIR/build.log" 2>&1 || {
  echo "Build failed:"; tail -30 "$RUN_DIR/build.log"; exit 1
}

echo "Serving it…"
nohup bun run preview --port "$WEB_PORT" --strictPort > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"

# ---------------------------------------------------------------------------
# 4. Wait until the link actually answers
# ---------------------------------------------------------------------------
echo -n "Waiting for the public link to answer"
for i in {1..60}; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$WEB_URL" || true)"
  [[ "$code" == "200" ]] && break
  echo -n "."
  sleep 2
done
echo

api_health="$(curl -s --max-time 8 "$API_URL/health" || echo 'unreachable')"

cat <<EOF

────────────────────────────────────────────────────────────
  PUBLIC LINK   $WEB_URL
  API           $API_URL   ($api_health)
────────────────────────────────────────────────────────────

  Logs   $RUN_DIR/{api,web,api-tunnel,web-tunnel}.log
  Stop   ./scripts/tunnel.sh stop

  Both hostnames are random and change every run. Wallet login
  needs $WEB_URL added to the allowed
  domains in your Privy dashboard, or the login modal will
  refuse to open on this origin.
EOF
