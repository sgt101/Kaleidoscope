#!/usr/bin/env bash
# The LaTeX editor in a container: the server, TeX Live (pdfLaTeX, LuaLaTeX, XeLaTeX, BibTeX, Biber) and every document
# you compile run in Docker. They see one folder of yours (the workspace) and nothing else of your machine.
#
#   ./run_contained.sh                          # open ./documents in the editor at http://localhost:3000
#   ./run_contained.sh --work ~/papers          # a different workspace folder
#   ./run_contained.sh --port 8080              # a different port on this machine
#   ./run_contained.sh --detach                 # run in the background; ./run_contained.sh --stop ends it
#   ./run_contained.sh --rebuild                # rebuild the image from scratch (fresh TeX Live and Node)
#   ./run_contained.sh --stop                   # stop a running container
#
# The first run builds the image (TeX Live, a few minutes and about 2 GB); later runs reuse it and only rebuild
# when the app's files change. Ctrl+C stops the container.
#
# What the container can and cannot do:
#   - sees only the workspace folder (read and write, so Save works) plus a private cache volume for fonts;
#   - the rest of its filesystem is read-only, it runs without Linux capabilities, as a non-root user, with limits
#     on memory (2 GB), CPUs (2) and processes;
#   - the page is published on 127.0.0.1 only, so nothing else on your network can reach it;
#   - nothing from your environment is passed in except the assistant's settings (below) and ALLOWED_HOSTS, read from
#     the environment or from ./.env. Documents compiled here, including LuaLaTeX ones, cannot read your home folder
#     or your keys: the TeX programs run with a bare environment, without any of them.
#
# The assistant calls model providers directly (see README, "The assistant"):
#   - MLX, Ollama or another local server on your machine: reached as host.docker.internal. The default is MLX at
#     http://127.0.0.1:8081/v1 (MLX_URL, MLX_MODEL); in providers.json "localhost" is rewritten the same way.
#   - Claude and OpenAI-style APIs: ANTHROPIC_API_KEY, or OPENAI_API_KEY with OPENAI_MODEL, or any key a provider in
#     providers.json names with "keyEnv". Keys go in by name (-e NAME), so they never appear in `ps`; they are visible
#     only to the editor's server process, never to the TeX programs. An API provider receives the open file.
#   - providers.json (copy providers.example.json) is mounted read-only when it exists.
#   - Trifle, if its token is found (TRIFLE_TOKEN, or ~/.config/trifle/token), appears as one more provider; its
#     bridge must accept host.docker.internal (--allow-host).
#
# Needs Docker (Docker Desktop on macOS). Tested on macOS with Docker Desktop; on Linux it runs as your user id.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="kaleidoscope"
NAME="kaleidoscope"
CACHE_VOLUME="kaleidoscope-cache"
PORT="${PORT:-3000}"
WORK="${WORKSPACE_DIR:-$HERE/documents}"
REBUILD=0
DETACH=0
STOP=0

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --work)    [ $# -ge 2 ] || die "--work needs a folder"; WORK="$2"; shift 2 ;;
        --port)    [ $# -ge 2 ] || die "--port needs a number"; PORT="$2"; shift 2 ;;
        --rebuild) REBUILD=1; shift ;;
        --detach|-d) DETACH=1; shift ;;
        --stop)    STOP=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *)         die "unknown option: $1 (try --help)" ;;
    esac
done

command -v docker >/dev/null 2>&1 || die "docker is not installed (macOS: install Docker Desktop from docker.com)"
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and try again."

if [ "$STOP" = 1 ]; then
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

# Only an old copy of this container may be holding the port; anything else is a real conflict.
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "Replacing the running $NAME container."
    docker rm -f "$NAME" >/dev/null
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $PORT is already in use on this machine (use --port to choose another)"
fi

# A value from the environment, else from ./.env (KEY=VALUE lines only; never executed).
env_value() {
    local key="$1" value="${!1:-}"
    if [ -z "$value" ] && [ -f "$HERE/.env" ]; then
        value="$(sed -n "s/^[[:space:]]*${key}=//p" "$HERE/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
    fi
    printf '%s' "$value"
}

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

# The assistant's providers. The container reaches services on your machine as host.docker.internal, so the server is told
# to read localhost that way (LOOPBACK_HOST). Secrets go in through the environment (-e NAME without a value).
RUN_FLAGS+=(-e LOOPBACK_HOST=host.docker.internal)
[ "$(uname -s)" = "Linux" ] && RUN_FLAGS+=(--add-host host.docker.internal:host-gateway)

PASS_NAMES="MLX_URL MLX_MODEL ANTHROPIC_API_KEY ANTHROPIC_MODEL OPENAI_API_KEY OPENAI_MODEL OPENAI_URL"
PROVIDERS_FILE_PATH="${PROVIDERS_FILE:-$HERE/providers.json}"
if [ -f "$PROVIDERS_FILE_PATH" ]; then
    RUN_FLAGS+=(-v "$PROVIDERS_FILE_PATH:/app/providers.json:ro" -e PROVIDERS_FILE=/app/providers.json)
    PASS_NAMES="$PASS_NAMES $(sed -n 's/.*"keyEnv"[[:space:]]*:[[:space:]]*"\([A-Za-z_][A-Za-z0-9_]*\)".*/\1/p' "$PROVIDERS_FILE_PATH" | tr '\n' ' ')"
fi
PASSED=""
for name in $PASS_NAMES; do
    value="$(env_value "$name")"
    if [ -n "$value" ]; then
        export "$name=$value"
        RUN_FLAGS+=(-e "$name")
        case "$name" in *_KEY) PASSED="$PASSED $name" ;; esac
    fi
done

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
if [ -f "$PROVIDERS_FILE_PATH" ]; then
    echo "  Assistant:  providers from $PROVIDERS_FILE_PATH"
else
    MLX_SHOWN="$(env_value MLX_URL)"
    echo "  Assistant:  MLX at ${MLX_SHOWN:-http://127.0.0.1:8081/v1} (via host.docker.internal)${PASSED:+, plus keys:$PASSED}${TRIFLE_TOKEN:+, Trifle}"
fi
if [ "$DETACH" = 1 ]; then
    docker run -d "${RUN_FLAGS[@]}" "$IMAGE" >/dev/null
    echo "  Running in the background. Logs: docker logs -f $NAME    Stop: ./run_contained.sh --stop"
else
    echo "  Press Ctrl+C to stop."
    echo
    exec docker run "${RUN_FLAGS[@]}" "$IMAGE"
fi
