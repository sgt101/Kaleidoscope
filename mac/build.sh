#!/bin/bash
# Builds Kaleidoscope.app and the Mac installer.
#
#   mac/build.sh app --link [--out DIR]   # an app that runs THIS checkout (default: ~/Desktop): your own desktop icon
#   mac/build.sh app [--out DIR]          # a self-contained app, with the program inside it (default: dist/)
#   mac/build.sh dmg                      # dist/Kaleidoscope-<version>.dmg: the app, an Applications link and a read-me,
#                                         # and the same as dist/Kaleidoscope.dmg, the name a GitHub release uses
#
# Signing, for a dmg other people download (optional; without it macOS makes them allow the app once, see the read-me):
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"  signs the app and the dmg
#   NOTARY_PROFILE=name   then notarises and staples them (xcrun notarytool store-credentials name ... first)
#
# Needs only what macOS has: Quick Look renders the icon, then sips, iconutil, hdiutil and codesign.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")"
BUNDLE_ID="${BUNDLE_ID:-local.kaleidoscope.editor}"
DIST="$ROOT/dist"

# What the self-contained app carries: the app and what builds its image. No documents, keys, .env or your providers.json.
APP_FILES=(run_contained.sh Dockerfile .dockerignore package.json package-lock.json
    server.js trifle.js providers.js assistant.js history.js synctex.js bridge.js setup.js
    providers.example.json README.md LICENSE .env.example public)
# The example document, copied into a new user's workspace on the first start.
EXAMPLE_FILES=(test.tex tikzflora.sty tikzflora-boot.lua tikzflora-LICENSE lua)

die() { echo "error: $*" >&2; exit 1; }

# AppIcon.icns from public/kaleidoscope.svg, with the margin macOS icons have.
make_icon() {
    local out="$1" tmp
    tmp="$(mktemp -d)"
    sed 's/viewBox="-220 -220 440 440"/viewBox="-268 -268 536 536"/' "$ROOT/public/kaleidoscope.svg" > "$tmp/icon.svg"
    qlmanage -t -s 1024 -o "$tmp" "$tmp/icon.svg" >/dev/null 2>&1
    [ -f "$tmp/icon.svg.png" ] || die "could not render the icon"
    mkdir -p "$tmp/AppIcon.iconset"
    for size in 16 32 128 256 512; do
        sips -z "$size" "$size" "$tmp/icon.svg.png" --out "$tmp/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
        sips -z "$((size * 2))" "$((size * 2))" "$tmp/icon.svg.png" --out "$tmp/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
    done
    iconutil -c icns "$tmp/AppIcon.iconset" -o "$out"
    rm -rf "$tmp"
}

build_app() {
    local link="$1" out="$2" app
    app="$out/Kaleidoscope.app"
    mkdir -p "$out"
    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Kaleidoscope</string>
    <key>CFBundleDisplayName</key><string>Kaleidoscope</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>Kaleidoscope</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
    install -m 755 "$HERE/launcher.sh" "$app/Contents/MacOS/Kaleidoscope"
    install -m 755 "$HERE/start.command" "$app/Contents/Resources/start.command"
    install -m 755 "$HERE/start.command" "$app/Contents/Resources/setup.command" # the same, run with --setup
    make_icon "$app/Contents/Resources/AppIcon.icns"
    if [ "$link" = 1 ]; then
        printf '%s' "$ROOT" > "$app/Contents/Resources/kaleidoscope-home"
    else
        mkdir -p "$app/Contents/Resources/app"
        (cd "$ROOT" && rsync -a --exclude '.DS_Store' "${APP_FILES[@]}" "$app/Contents/Resources/app/")
        chmod 755 "$app/Contents/Resources/app/run_contained.sh"
        mkdir -p "$app/Contents/Resources/app/example"
        (cd "$ROOT/documents" && rsync -a --exclude '.DS_Store' "${EXAMPLE_FILES[@]}" "$app/Contents/Resources/app/example/")
    fi
    if [ -n "${SIGN_IDENTITY:-}" ]; then
        codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$app"
    else
        codesign --force --sign - "$app" # ad hoc: holds the bundle together, but is not a Developer ID
    fi
    touch "$app" # so the Finder shows the new icon
    echo "Built $app"
}

notarise() {
    [ -n "${NOTARY_PROFILE:-}" ] || return 0
    [ -n "${SIGN_IDENTITY:-}" ] || die "NOTARY_PROFILE needs SIGN_IDENTITY"
    xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$1"
}

build_dmg() {
    local stage dmg
    stage="$(mktemp -d)/Kaleidoscope"
    mkdir -p "$stage"
    build_app 0 "$stage"
    if [ -n "${NOTARY_PROFILE:-}" ]; then
        ditto -c -k --keepParent "$stage/Kaleidoscope.app" "$stage/../app.zip"
        notarise "$stage/../app.zip" >/dev/null || die "notarising the app failed"
        xcrun stapler staple "$stage/Kaleidoscope.app"
        rm -f "$stage/../app.zip"
    fi
    ln -s /Applications "$stage/Applications"
    cp "$HERE/Read me first.txt" "$stage/"
    mkdir -p "$DIST"
    dmg="$DIST/Kaleidoscope-$VERSION.dmg"
    rm -f "$dmg"
    hdiutil create -volname "Kaleidoscope" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg" >/dev/null
    rm -rf "$(dirname "$stage")"
    [ -n "${SIGN_IDENTITY:-}" ] && codesign --sign "$SIGN_IDENTITY" --timestamp "$dmg"
    notarise "$dmg"
    # The same file under a fixed name, for a GitHub release: the README links to releases/latest/download/Kaleidoscope.dmg.
    cp -f "$dmg" "$DIST/Kaleidoscope.dmg"
    echo "Built $dmg and $DIST/Kaleidoscope.dmg"
}

[ "$(uname -s)" = Darwin ] || die "this builds a Mac app: run it on a Mac"
case "${1:-}" in
    app)
        shift
        LINK=0; OUT=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --link) LINK=1; shift ;;
                --out)  [ $# -ge 2 ] || die "--out needs a folder"; OUT="$2"; shift 2 ;;
                *)      die "unknown option: $1" ;;
            esac
        done
        if [ -z "$OUT" ]; then [ "$LINK" = 1 ] && OUT="$HOME/Desktop" || OUT="$DIST"; fi
        build_app "$LINK" "$OUT"
        ;;
    dmg) build_dmg ;;
    *) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
