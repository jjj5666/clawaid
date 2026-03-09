#!/bin/bash
# Batch test all mock scenarios via --mock CLI flag + --dry-run
# Safe: uses fake data, never touches real system

SCENARIOS=(
  "all-healthy"
  "proxy-in-plist"
  "gateway-down"
  "config-syntax-error"
  "port-conflict"
  "zombie-gateway"
  "bad-model"
  "multiple-issues"
)

RESULTS_DIR="test-results-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "🧪 Testing ${#SCENARIOS[@]} scenarios..."
echo ""

for scenario in "${SCENARIOS[@]}"; do
  echo "━━━ Testing: $scenario ━━━"
  
  PORT=$((4000 + RANDOM % 1000))
  
  # Start server with --mock and --dry-run flags
  node dist/index.js --mock "$scenario" --dry-run --port $PORT --no-open > /dev/null 2>&1 &
  PID=$!
  sleep 2
  
  # Start SSE listener
  RAW_FILE="$RESULTS_DIR/$scenario-raw.txt"
  curl -sN "http://127.0.0.1:$PORT/api/diagnose" > "$RAW_FILE" 2>&1 &
  CURL_PID=$!
  
  # Wait for session ID, then skip user description
  sleep 2
  SESSION_ID=$(grep -o '"sessionId":"[^"]*"' "$RAW_FILE" 2>/dev/null | head -1 | sed 's/"sessionId":"//;s/"//')
  
  if [ -n "$SESSION_ID" ]; then
    curl -s -X POST "http://127.0.0.1:$PORT/api/input" \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$SESSION_ID\",\"field\":\"userDescription\",\"value\":\"\"}" > /dev/null 2>&1
  fi
  
  # Wait for completion or timeout (90s)
  WAITED=0
  while kill -0 $CURL_PID 2>/dev/null && [ $WAITED -lt 90 ]; do
    sleep 3
    WAITED=$((WAITED + 3))
    if grep -q '"type":"complete"\|"type":"error"' "$RAW_FILE" 2>/dev/null; then
      sleep 1
      kill $CURL_PID 2>/dev/null
      break
    fi
    # Auto-approve any confirm prompts (for fix steps in dry-run)
    if grep -q '"type":"confirm_needed"' "$RAW_FILE" 2>/dev/null; then
      curl -s -X POST "http://127.0.0.1:$PORT/api/confirm" \
        -H "Content-Type: application/json" \
        -d "{\"sessionId\":\"$SESSION_ID\",\"confirmed\":true}" > /dev/null 2>&1
    fi
  done
  kill $CURL_PID 2>/dev/null 2>&1
  wait $CURL_PID 2>/dev/null
  
  # Parse results
  READS=$(grep -o '"type":"read"' "$RAW_FILE" 2>/dev/null | wc -l | tr -d ' ')
  FIXES=$(grep -o '"type":"fix"' "$RAW_FILE" 2>/dev/null | wc -l | tr -d ' ')
  
  if grep -q '"healthy":true' "$RAW_FILE" 2>/dev/null; then
    STATE="✅ HEALTHY"
  elif grep -q '"fixed":true' "$RAW_FILE" 2>/dev/null; then
    STATE="🔧 FIXED"
  elif grep -q '"fixed":false' "$RAW_FILE" 2>/dev/null; then
    STATE="❌ NOT FIXED"
  elif grep -q '"type":"error"' "$RAW_FILE" 2>/dev/null; then
    STATE="💥 ERROR"
  else
    STATE="⏱️ TIMEOUT"
  fi
  
  SUMMARY=$(grep -o '"summary":"[^"]*"' "$RAW_FILE" 2>/dev/null | tail -1 | sed 's/"summary":"//;s/"$//')
  
  echo "  $STATE | reads=$READS fixes=$FIXES"
  [ -n "$SUMMARY" ] && echo "  ${SUMMARY:0:120}"
  echo ""
  
  kill $PID 2>/dev/null
  wait $PID 2>/dev/null
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Full results in $RESULTS_DIR/"
