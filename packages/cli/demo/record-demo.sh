#!/usr/bin/env bash
# Fairtrail CLI Demo — Two-part recording
# Part 1: search (1x2 Claude Code vs Codex)
# Part 2: view → tmux (1x2 → 2x2)
#
# Usage: ./packages/cli/demo/record-demo.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SESSION="ft-rec"
DEMO_DIR="$(pwd)/packages/cli/demo"

Q1="Round trip Frankfurt to Bogota or Medellin, Dec 5 to Dec 15, max 1 stop"
Q2="Round trip Frankfurt to Cartagena or Lima, Dec 5 to Dec 15, max 2 stops"

type_slow() {
  local pane=$1 text=$2
  for (( i=0; i<${#text}; i++ )); do
    tmux send-keys -t "$pane" -l "${text:$i:1}"
    sleep 0.03
  done
}

kill_ink() {
  tmux send-keys -t "$1" C-c; sleep 0.3
  tmux send-keys -t "$1" C-c; sleep 0.3
}

start_recording() {
  local out=$1
  osascript -e 'tell application "Ghostty" to activate' 2>/dev/null || true
  sleep 1
  WID=$(/tmp/get_window_id ghostty 2>/dev/null)
  screencapture -v -x -l "$WID" "/tmp/$(basename "$out")" &
  REC_PID=$!
  sleep 1
  echo "Recording → $out (PID=$REC_PID, WID=$WID)"
}

stop_recording() {
  local out=$1
  kill -INT "$REC_PID" 2>/dev/null || true
  wait "$REC_PID" 2>/dev/null || true
  sleep 2
  local tmpfile="/tmp/$(basename "$out")"
  if [ -f "$tmpfile" ]; then
    cp "$tmpfile" "$out"
    echo "Saved: $out ($(ls -lh "$out" | awk '{print $5}'))"
  else
    echo "WARNING: recording not found at $tmpfile"
  fi
}

echo "=== Fairtrail CLI Demo ==="

# Clean
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux kill-session -t fairtrail-view 2>/dev/null || true
pkill -f screencapture 2>/dev/null || true

# Create 1x2 tmux
tmux new-session -d -s "$SESSION" -x 220 -y 55
WIN=$(tmux list-windows -t "$SESSION" -F '#{window_index}' | head -1)
P1="$SESSION:$WIN.1"
P2="$SESSION:$WIN.2"
tmux split-window -h -t "$SESSION:$WIN"
tmux select-layout -t "$SESSION:$WIN" even-horizontal

tmux send-keys -t "$P1" "export PATH=$DEMO_DIR:\$PATH && cd $(pwd) && clear" Enter
tmux send-keys -t "$P2" "export PATH=$DEMO_DIR:\$PATH && cd $(pwd) && clear" Enter
sleep 1

# Open Ghostty and ensure NOT fullscreen
ghostty -e tmux attach-session -t "$SESSION" &
disown
sleep 3
osascript -e '
tell application "System Events"
  tell process "Ghostty"
    set frontmost to true
    try
      click menu item "Exit Full Screen" of menu "Window" of menu bar 1
    end try
  end tell
end tell
' 2>/dev/null || true
sleep 2
tmux send-keys -t "$P1" "clear" Enter
tmux send-keys -t "$P2" "clear" Enter
sleep 1

# ══════════════════════════════════════════
# PART 1: SEARCH
# ══════════════════════════════════════════
start_recording "$DEMO_DIR/fairtrail-search.mov"

tmux send-keys -t "$P1" "fairtrail --headless --backend claude-code" Enter
sleep 0.5
tmux send-keys -t "$P2" "fairtrail --headless --backend codex" Enter
sleep 4

type_slow "$P1" "$Q1"
sleep 0.3
type_slow "$P2" "$Q2"
sleep 0.8

tmux send-keys -t "$P1" Enter
sleep 0.3
tmux send-keys -t "$P2" Enter
echo "[search] Queries submitted..."

for round in $(seq 1 80); do
  sleep 5
  for PANE in "$P1" "$P2"; do
    CONTENT=$(tmux capture-pane -t "$PANE" -p -S -30 2>/dev/null || true)
    echo "$CONTENT" | grep -q "Search flights" && tmux send-keys -t "$PANE" Enter && echo "  [$PANE] confirmed search"
    echo "$CONTENT" | grep -q "Select flights\|Track selected" && tmux send-keys -t "$PANE" Enter && echo "  [$PANE] confirmed selection"
  done
  L=$(tmux capture-pane -t "$P1" -p -S -30 2>/dev/null | grep -c "View with" || true)
  R=$(tmux capture-pane -t "$P2" -p -S -30 2>/dev/null | grep -c "View with" || true)
  echo "  [check $round] L=$L R=$R"
  [ "$L" -gt 0 ] && [ "$R" -gt 0 ] && echo "[search] Both done!" && break
done

sleep 3

L_ID=$(tmux capture-pane -t "$P1" -p -S -30 2>/dev/null | grep -oE 'cm[a-z0-9]{15,}' | tail -1)
R_ID=$(tmux capture-pane -t "$P2" -p -S -30 2>/dev/null | grep -oE 'cm[a-z0-9]{15,}' | tail -1)
echo "IDs: left=$L_ID right=$R_ID"

stop_recording "$DEMO_DIR/fairtrail-search.mov"
echo "[search] Recording saved"

# ══════════════════════════════════════════
# INTERLUDE: Fast-forward
# ══════════════════════════════════════════
kill_ink "$P1"
kill_ink "$P2"
tmux send-keys -t "$P1" "clear" Enter
tmux send-keys -t "$P2" "clear" Enter
sleep 0.5

tmux send-keys -t "$P1" "echo ''" Enter
tmux send-keys -t "$P1" "echo '  ⏩  Fast-forwarding 5 days of price tracking...'" Enter
tmux send-keys -t "$P1" "echo '      (scraping every 3 hours via cron)'" Enter
tmux send-keys -t "$P2" "echo ''" Enter
tmux send-keys -t "$P2" "echo '  ⏩  Fast-forwarding 5 days of price tracking...'" Enter
tmux send-keys -t "$P2" "echo '      (scraping every 3 hours via cron)'" Enter
sleep 2

infisical run --projectId 48fd7083-5c5c-425b-8900-24e6b2626ea5 --env dev -- node --import tsx/esm --import ./packages/cli/register.mjs -e "
import { prisma } from '@/lib/prisma';
const queryIds = ['$L_ID', '$R_ID'];
const now = Date.now();
const DAY = 24*60*60*1000;
for (const qId of queryIds) {
  const q = await prisma.query.findUnique({ where: { id: qId }, include: { snapshots: { take: 10 } } });
  if (!q || q.snapshots.length === 0) continue;
  const airlines = [...new Set(q.snapshots.map(s => s.airline))].slice(0, 5);
  const snaps = [];
  for (let day = 5; day >= 1; day--) {
    for (const airline of airlines) {
      const real = q.snapshots.find(s => s.airline === airline);
      const base = real?.price ?? 700;
      const drift = (Math.random() - 0.3) * 15 * (5 - day);
      const noise = (Math.random() - 0.5) * 40;
      snaps.push({
        queryId: qId, travelDate: q.dateFrom,
        price: Math.round(base + drift + noise), currency: q.currency,
        airline, bookingUrl: real?.bookingUrl ?? 'https://google.com/travel/flights',
        stops: real?.stops ?? 1, duration: real?.duration ?? null,
        scrapedAt: new Date(now - day * DAY), status: 'available',
      });
    }
  }
  await prisma.priceSnapshot.createMany({ data: snaps });
  console.log('  Seeded ' + snaps.length + ' snapshots for ' + q.origin + ' -> ' + q.destination);
}
process.exit(0);
" 2>&1 | grep "Seeded"

tmux send-keys -t "$P1" "echo '  ✓  5 days of data ready'" Enter
tmux send-keys -t "$P2" "echo '  ✓  5 days of data ready'" Enter
sleep 3

# ══════════════════════════════════════════
# PART 2: VIEW → TMUX
# ══════════════════════════════════════════
tmux send-keys -t "$P1" "clear" Enter
tmux send-keys -t "$P2" "clear" Enter
sleep 0.5

start_recording "$DEMO_DIR/fairtrail-view.mov"

# Single chart view (no --backend needed, data is in DB)
V1="fairtrail --headless --view $L_ID"
V2="fairtrail --headless --view $R_ID"
type_slow "$P1" "$V1"
sleep 0.2
type_slow "$P2" "$V2"
sleep 0.5
tmux send-keys -t "$P1" Enter
tmux send-keys -t "$P2" Enter
echo "[view] Charts loading..."
sleep 15

# --tmux (no --backend needed)
kill_ink "$P1"
kill_ink "$P2"
sleep 0.5
tmux send-keys -t "$P1" "clear" Enter
tmux send-keys -t "$P2" "clear" Enter
sleep 0.5

T1="fairtrail --headless --view $L_ID --tmux"
T2="fairtrail --headless --view $R_ID --tmux"
type_slow "$P1" "$T1"
sleep 0.2
type_slow "$P2" "$T2"
sleep 0.5
tmux send-keys -t "$P1" Enter
sleep 2
tmux send-keys -t "$P2" Enter
echo "[view] Tmux panes..."
sleep 15

stop_recording "$DEMO_DIR/fairtrail-view.mov"
echo "[view] Recording saved"

# ══════════════════════════════════════════
# Convert
# ══════════════════════════════════════════
for NAME in search view; do
  MOV="$DEMO_DIR/fairtrail-${NAME}.mov"
  if [ -f "$MOV" ]; then
    ffmpeg -i "$MOV" -c:v libx264 -pix_fmt yuv420p -crf 18 "$DEMO_DIR/fairtrail-${NAME}.mp4" -y 2>/dev/null
    ffmpeg -i "$MOV" \
      -vf "fps=12,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
      "$DEMO_DIR/fairtrail-${NAME}.gif" -y 2>/dev/null
    echo "  $NAME: $(ls -lh "$DEMO_DIR/fairtrail-${NAME}.mp4" | awk '{print $5}') MP4, $(ls -lh "$DEMO_DIR/fairtrail-${NAME}.gif" | awk '{print $5}') GIF"
  fi
done

echo ""
echo "=== Done ==="
ls -lh "$DEMO_DIR"/fairtrail-{search,view}.{mov,mp4,gif} 2>/dev/null
