#!/usr/bin/env bash
# A private, headless KWin for the Firefox check on a Wayland desktop: its own D-Bus session,
# config dirs and Wayland socket, one virtual 1400×900 output. Nothing appears on the real
# screens, and the desktop's mouse and focus play no part. KWin still composites on the GPU.
#   test/firefox/headless-kwin.sh <command...>   runs the command inside it, then tears it down
# Inside: WAYLAND_DISPLAY is this KWin, `busctl --user` reaches it, and its screenshot interface
# answers any caller (KWIN_SCREENSHOT_NO_PERMISSION_CHECKS).
#
# The environment is set before the private bus starts (dbus-daemon hands it to what it
# starts), and the bus starts no services: a portal started on it would point at the real
# desktop, and crash when this KWin goes away.
set -euo pipefail

if [[ "${MTHUB_KWIN_INNER:-}" != 1 ]]; then
    tmp=$(mktemp -d /tmp/mthub-kwin.XXXXXX)
    trap 'rm -rf "$tmp"' EXIT
    export MTHUB_KWIN_TMP=$tmp MTHUB_KWIN_INNER=1
    export XDG_CONFIG_HOME=$tmp/config XDG_DATA_HOME=$tmp/data XDG_STATE_HOME=$tmp/state XDG_CACHE_HOME=$tmp/cache
    export WAYLAND_DISPLAY=mthub-kwin-${tmp##*.}
    unset DISPLAY XAUTHORITY QT_PLUGIN_PATH
    export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent/none
    mkdir -p "$XDG_CONFIG_HOME"
    cat > "$tmp/bus.conf" <<'CONF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF
    status=0
    timeout 240 dbus-run-session --config-file="$tmp/bus.conf" -- "$0" "$@" \
        2> >(grep -vE 'dbus-daemon\[|dbind-WARNING|AT-SPI' >&2) || status=$?
    exit $status
fi

tmp=$MTHUB_KWIN_TMP
kwin=""
teardown() {
    # The command's own children are its to stop; then KWin, waited for.
    if [[ -n $kwin ]]; then
        kill "$kwin" 2>/dev/null || true
        for _ in $(seq 30); do kill -0 "$kwin" 2>/dev/null || break; sleep 0.1; done
        kill -9 "$kwin" 2>/dev/null || true
    fi
}
trap teardown EXIT
export KWIN_SCREENSHOT_NO_PERMISSION_CHECKS=1
kwin_wayland --virtual --width 1400 --height 900 --socket "$WAYLAND_DISPLAY" >"$tmp/kwin.out" 2>&1 &
kwin=$!
for _ in $(seq 100); do
    [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] && busctl --user status org.kde.KWin >/dev/null 2>&1 && break
    sleep 0.1
done
busctl --user status org.kde.KWin >/dev/null 2>&1 || { echo "headless-kwin: KWin did not start" >&2; cat "$tmp/kwin.out" >&2; exit 1; }
status=0
"$@" || status=$?
[[ $status == 0 ]] || { echo "--- headless KWin's output:" >&2; tail -20 "$tmp/kwin.out" >&2; }
exit $status
