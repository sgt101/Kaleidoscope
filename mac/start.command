#!/bin/bash
# Started in Terminal by Kaleidoscope.app. Runs run_contained.sh and opens the browser when the editor is ready.
# Close this window, or press Ctrl+C, to stop Kaleidoscope.
RES="$(cd "$(dirname "$0")" && pwd)"
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin"
printf '\033]0;Kaleidoscope\007' # the window's title

if [ -f "$RES/kaleidoscope-home" ]; then
    # Built with --link: run a checkout, with its own documents folder.
    HOME_DIR="$(cat "$RES/kaleidoscope-home")"
    ARGS=()
else
    # The installed app: the program inside it, and the documents in ~/Documents/Kaleidoscope.
    HOME_DIR="$RES/app"
    WORK="$HOME/Documents/Kaleidoscope"
    if [ ! -d "$WORK" ]; then
        mkdir -p "$WORK"
        cp -R "$HOME_DIR/example/." "$WORK/" # the first time: an example to try (test.tex)
    fi
    ARGS=(--work "$WORK")
fi

if [ ! -x "$HOME_DIR/run_contained.sh" ]; then
    echo "Kaleidoscope is not at $HOME_DIR any more. Rebuild the app (mac/build.sh) from where it is now."
    read -r -p "Press Return to close." _
    exit 1
fi

cd "$HOME_DIR" || exit 1
"$HOME_DIR/run_contained.sh" --open "${ARGS[@]+"${ARGS[@]}"}"
status=$?
if [ "$status" != 0 ] && [ "$status" != 130 ] && [ "$status" != 129 ]; then
    echo
    read -r -p "Kaleidoscope stopped with an error (above). Press Return to close." _
fi
exit "$status"
