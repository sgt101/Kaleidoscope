#!/bin/bash
# Kaleidoscope.app's own program (Contents/MacOS/Kaleidoscope). Double-clicking the app runs this. It checks for Docker,
# opens the editor if it is already running, and otherwise starts it in a Terminal window (start.command), where the
# first-run questions, the first build and Ctrl+C all work as they do from a shell.
set -u

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
URL="http://localhost:3000"
# An app opened from the Finder gets a bare PATH: add where Docker Desktop and Homebrew put their commands.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin"

say() { /usr/bin/osascript -e "display dialog \"$1\" with title \"Kaleidoscope\" buttons {$2} default button 1 with icon caution" 2>/dev/null; }

if ! command -v docker >/dev/null 2>&1; then
    if say "Kaleidoscope runs in Docker, which is not installed. Install Docker Desktop, start it once, then open Kaleidoscope again." '"Get Docker", "Cancel"' | grep -q "Get Docker"; then
        open "https://www.docker.com/products/docker-desktop/"
    fi
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    /usr/bin/osascript -e 'display notification "Starting Docker Desktop…" with title "Kaleidoscope"' 2>/dev/null
    open -a Docker 2>/dev/null
    for _ in $(seq 1 120); do docker info >/dev/null 2>&1 && break; sleep 1; done
    if ! docker info >/dev/null 2>&1; then
        say "Docker did not start. Start Docker Desktop, wait until it says it is running, then open Kaleidoscope again." '"OK"' >/dev/null
        exit 1
    fi
fi

# Already running: just show it.
if docker ps --format '{{.Names}}' | grep -qx kaleidoscope && curl -fs -o /dev/null "$URL/"; then
    open "$URL"
    exit 0
fi

open -a Terminal "$RES/start.command"
