#!/usr/bin/env bash
# The LaTeX editor in a container: the server, TeX Live (pdfLaTeX, LuaLaTeX, XeLaTeX, BibTeX, Biber) and every document
# you compile run in Docker. They see one folder of yours (the workspace) and nothing else of your machine.
#
#   ./run_contained.sh                          # open ./documents in the editor at http://localhost:3000
#   ./run_contained.sh --work ~/papers          # a different workspace folder
#   ./run_contained.sh --port 8080              # a different port on this machine
#   ./run_contained.sh --detach                 # run in the background; ./run_contained.sh --stop ends it and the bridge
#   ./run_contained.sh --open                   # also open the editor in your browser once it is ready
#   ./run_contained.sh --setup                  # choose the assistant's models and say where your keys are, then start
#   ./run_contained.sh --rebuild                # rebuild the image from scratch (fresh TeX Live and Node)
#   ./run_contained.sh --stop                   # stop a running container and its bridge
#
# The first run asks a few questions about the assistant (setup.js), then builds the image (TeX Live, a few minutes and about
# 2 GB); later runs reuse it and only rebuild when the app's files change. Ctrl+C stops the container.
#
# What the container can and cannot do:
#   - sees only the workspace folder (read and write, so Save works) plus a private cache volume for fonts;
#   - the rest of its filesystem is read-only, it runs without Linux capabilities, as a non-root user, with limits
#     on memory (2 GB), CPUs (2) and processes;
#   - the page is published on 127.0.0.1 only, so nothing else on your network can reach it;
#   - nothing from your environment is passed in except ALLOWED_HOSTS, read from the environment or from ./.env, and what
#     Trifle needs (below). Your API keys never enter the container.
#
# The assistant reaches its models through a bridge on this machine (bridge.js, see README, "The assistant"), which this
# script starts and stops with the container. Everything about providers is read there, not in the container:
#   - MLX, Ollama or another local server: the default is MLX at http://127.0.0.1:8081/v1 (MLX_URL, MLX_MODEL).
#   - Claude and OpenAI-style APIs: ANTHROPIC_API_KEY, or OPENAI_API_KEY with OPENAI_MODEL, or any key a provider in
#     providers.json names with "keyEnv", from the environment or ./.env, or on a Mac from the Keychain (an item with that
#     name, or the name in the provider's "keychain"). macOS may ask you to allow this. An API provider receives the open file.
#   - The list of providers comes from PROVIDERS_FILE, else the file setup saved in ~/.config/kaleidoscope, else providers.json.
#   - The container gets only a token for the bridge, new each run, which is of no use anywhere else. BRIDGE_PORT
#     (default 8793) chooses the bridge's port. The bridge needs Node on this machine; without it the editor works
#     but the assistant does not.
#   - Trifle, if its token is found (TRIFLE_TOKEN, or ~/.config/trifle/token), is not reached through the bridge: it appears
#     as one more provider, with its token in the container, and its own bridge must accept host.docker.internal
#     (--allow-host).
#
# Needs Docker (Docker Desktop on macOS). Tested on macOS with Docker Desktop; on Linux it runs as your user id.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="kaleidoscope"
NAME="kaleidoscope"
CACHE_VOLUME="kaleidoscope-cache"
PORT="${PORT:-3000}"
WORK="${WORKSPACE_DIR:-$HERE/documents}"
BRIDGE_PORT="${BRIDGE_PORT:-8793}"
BRIDGE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/kaleidoscope"
BRIDGE_PID_FILE="$BRIDGE_DIR/bridge.pid"
BRIDGE_LOG="$BRIDGE_DIR/bridge.log"
SAVED_PROVIDERS="$BRIDGE_DIR/providers.json"
SETUP=0
REBUILD=0
DETACH=0
STOP=0
OPEN=0

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 1; }

# Stops the bridge this script started, if it is still that process.
stop_bridge() {
    local pid
    pid="$(cat "$BRIDGE_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q 'bridge\.js'; then
        kill "$pid" 2>/dev/null || true
        while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    fi
    rm -f "$BRIDGE_PID_FILE"
}

# Starts the bridge with this run's token, and waits for it. It reads the keys itself, from this environment, ./.env and the
# Keychain, before it listens, so the wait includes however long you take to answer a Keychain prompt.
start_bridge() {
    local pid
    stop_bridge
    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        die "port $BRIDGE_PORT, which the bridge uses, is already in use on this machine (set BRIDGE_PORT to choose another)"
    fi
    mkdir -p "$BRIDGE_DIR"
    chmod 700 "$BRIDGE_DIR"
    BRIDGE_PORT="$BRIDGE_PORT" BRIDGE_HOST="$BRIDGE_HOST" nohup node "$HERE/bridge.js" </dev/null >"$BRIDGE_LOG" 2>&1 &
    pid=$!
    echo "$pid" > "$BRIDGE_PID_FILE"
    echo "  Bridge:     starting. If macOS asks to use a key from your Keychain, choose Always Allow."
    for _ in $(seq 1 3000); do
        if (exec 3<>"/dev/tcp/$BRIDGE_HOST/$BRIDGE_PORT") 2>/dev/null; then return 0; fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    cat "$BRIDGE_LOG" >&2
    stop_bridge
    die "the bridge did not start"
}

# A value from the environment, else from ./.env (KEY=VALUE lines only; never executed).
env_value() {
    local key="$1" value="${!1:-}"
    if [ -z "$value" ] && [ -f "$HERE/.env" ]; then
        value="$(sed -n "s/^[[:space:]]*${key}=//p" "$HERE/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
    fi
    printf '%s' "$value"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --work)    [ $# -ge 2 ] || die "--work needs a folder"; WORK="$2"; shift 2 ;;
        --port)    [ $# -ge 2 ] || die "--port needs a number"; PORT="$2"; shift 2 ;;
        --setup)   SETUP=1; shift ;;
        --rebuild) REBUILD=1; shift ;;
        --detach|-d) DETACH=1; shift ;;
        --stop)    STOP=1; shift ;;
        --open)    OPEN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *)         die "unknown option: $1 (try --help)" ;;
    esac
done

command -v docker >/dev/null 2>&1 || die "docker is not installed (macOS: install Docker Desktop from docker.com)"
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and try again."

if [ "$STOP" = 1 ]; then
    stop_bridge
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
        docker rm -f "$NAME" >/dev/null
        echo "Stopped $NAME."
    else
        echo "$NAME is not running."
    fi
    exit 0
fi

case "$PORT" in ''|*[!0-9]*) die "--port must be a number, got '$PORT'" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be between 1 and 65535"
[ -d "$WORK" ] || die "workspace folder not found: $WORK (use --work to choose one)"
WORK="$(cd "$WORK" && pwd -P)"
case "$WORK" in
    /|"$HOME") die "refusing to share $WORK; pick a folder that only holds your documents (--work)" ;;
esac

# The assistant's setup: the first time, or when asked. Before anything is replaced or built, so that cancelling it costs nothing.
HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1
if [ "$SETUP" = 1 ]; then
    [ "$HAVE_NODE" = 1 ] || die "setup needs Node.js 20 or later on this machine (nodejs.org)"
    [ -t 0 ] && [ -t 1 ] || die "setup asks questions, so it needs a terminal"
elif [ "$HAVE_NODE" = 1 ] && [ ! -f "$SAVED_PROVIDERS" ] && [ -z "$(env_value PROVIDERS_FILE)" ]; then
    if [ -t 0 ] && [ -t 1 ]; then
        SETUP=1
    else
        echo "Skipping the first-run setup, which needs a terminal. Run ./run_contained.sh --setup from one to choose your models."
    fi
fi
if [ "$SETUP" = 1 ]; then
    node "$HERE/setup.js" || exit $?
fi

# Only an old copy of this container may be holding the port; anything else is a real conflict.
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "Replacing the running $NAME container."
    docker rm -f "$NAME" >/dev/null
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $PORT is already in use on this machine (use --port to choose another)"
fi

echo "Building the image (the first time downloads TeX Live and takes a few minutes)..."
BUILD_FLAGS=()
[ "$REBUILD" = 1 ] && BUILD_FLAGS+=(--pull --no-cache)
docker build ${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"} -t "$IMAGE" "$HERE"

RUN_FLAGS=(
    --rm --init --name "$NAME"
    -p "127.0.0.1:${PORT}:3000"
    --read-only
    --tmpfs /tmp:rw,size=512m,mode=1777
    --cap-drop ALL
    --security-opt no-new-privileges
    --memory 2g --cpus 2 --pids-limit 512
    -v "$WORK:/workspace"
    -e HOST=0.0.0.0 -e PORT=3000 -e WORKSPACE_DIR=/workspace
)

# Fonts and parse caches (LuaLaTeX, XeLaTeX, Biber) live in the home folder. A named volume keeps them between runs;
# on Linux the container runs as your user id so that files you save keep your ownership.
if [ "$(uname -s)" = "Linux" ]; then
    RUN_FLAGS+=(--user "$(id -u):$(id -g)" -e HOME=/home/node
        --tmpfs "/home/node:rw,exec,mode=700,uid=$(id -u),gid=$(id -g),size=1g")
else
    RUN_FLAGS+=(-v "$CACHE_VOLUME:/home/node")
fi

ALLOWED_HOSTS_VALUE="$(env_value ALLOWED_HOSTS)"
[ -n "$ALLOWED_HOSTS_VALUE" ] && RUN_FLAGS+=(-e "ALLOWED_HOSTS=$ALLOWED_HOSTS_VALUE")

# The assistant's models, through the bridge. The container reaches this machine as host.docker.internal. Docker Desktop carries
# that to 127.0.0.1, so the bridge stays on loopback there; on Linux it is the Docker bridge network's gateway address.
BRIDGE_HOST=127.0.0.1
if [ "$(uname -s)" = "Linux" ]; then
    RUN_FLAGS+=(--add-host host.docker.internal:host-gateway)
    BRIDGE_HOST="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
fi
if [ "$HAVE_NODE" = 1 ]; then
    BRIDGE_TOKEN="$(node -p "require('crypto').randomBytes(32).toString('hex')")"
    export BRIDGE_TOKEN # by name, so that it never appears in `ps`
    RUN_FLAGS+=(-e BRIDGE_TOKEN)
fi
RUN_FLAGS+=(-e "BRIDGE_URL=http://host.docker.internal:$BRIDGE_PORT")

# Trifle (optional): the token and bridge address.
TRIFLE_URL_VALUE="$(env_value TRIFLE_URL)"
TRIFLE_URL_VALUE="${TRIFLE_URL_VALUE:-http://host.docker.internal:8792}"
TRIFLE_URL_VALUE="$(printf '%s' "$TRIFLE_URL_VALUE" | sed -E 's#//(localhost|127\.0\.0\.1)([:/]|$)#//host.docker.internal\2#')"
TRIFLE_TOKEN="$(env_value TRIFLE_TOKEN)"
if [ -z "$TRIFLE_TOKEN" ]; then
    TOKEN_FILE="${TRIFLE_TOKEN_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/trifle/token}"
    [ -r "$TOKEN_FILE" ] && TRIFLE_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi
if [ -n "$TRIFLE_TOKEN" ]; then
    export TRIFLE_TOKEN
    RUN_FLAGS+=(-e TRIFLE_TOKEN -e "TRIFLE_URL=$TRIFLE_URL_VALUE")
fi

echo
echo "  Editor:     http://localhost:${PORT}"
echo "  Workspace:  $WORK  (mounted at /workspace)"
if [ "$HAVE_NODE" = 1 ]; then
    trap stop_bridge EXIT
    start_bridge
    echo "  Assistant:  through the bridge on port $BRIDGE_PORT, which keeps your keys on this machine (log: $BRIDGE_LOG)"
else
    echo "  Assistant:  off. The bridge to your models needs Node.js 20 or later on this machine (nodejs.org). Install it and run this again."
fi
# --open: the browser, as soon as the editor answers (the image is built by now, so this is seconds).
if [ "$OPEN" = 1 ]; then
    (
        for _ in $(seq 1 600); do
            if curl -fs -o /dev/null "http://localhost:${PORT}/"; then
                if command -v open >/dev/null 2>&1; then open "http://localhost:${PORT}"; else xdg-open "http://localhost:${PORT}" >/dev/null 2>&1; fi
                exit 0
            fi
            sleep 0.5
        done
    ) &
fi
if [ "$DETACH" = 1 ]; then
    docker run -d "${RUN_FLAGS[@]}" "$IMAGE" >/dev/null
    trap - EXIT
    echo "  Running in the background. Logs: docker logs -f $NAME    Stop: ./run_contained.sh --stop"
else
    echo "  Press Ctrl+C to stop."
    echo
    # Closing the terminal window hangs up on this script: the container goes too, not only the docker command.
    trap 'docker rm -f "$NAME" >/dev/null 2>&1; exit 129' HUP
    docker run "${RUN_FLAGS[@]}" "$IMAGE"
fi
