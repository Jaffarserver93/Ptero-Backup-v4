#!/usr/bin/env bash
set -e

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/scripts" && pwd)"
ENV_FILE="$SCRIPTS_DIR/.env"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║   Pterodactyl → Telegram Backup Bot Setup    ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ─── Helper: ask with optional default ───────────────────────────────────────

ask() {
  local prompt="$1"
  local var="$2"
  local default="$3"
  local silent="$4"

  if [ -n "$default" ]; then
    echo -ne "${CYAN}${prompt}${NC} ${YELLOW}[${default}]${NC}: "
  else
    echo -ne "${CYAN}${prompt}${NC}: "
  fi

  if [ "$silent" = "true" ]; then
    read -rs input
    echo ""
  else
    read -r input
  fi

  if [ -z "$input" ] && [ -n "$default" ]; then
    input="$default"
  fi

  eval "$var='$input'"
}

# ─── Step 1: Check dependencies ───────────────────────────────────────────────

echo -e "${BOLD}[1/3] Checking dependencies...${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install it from https://nodejs.org${NC}"
  exit 1
fi

if ! command -v pnpm &>/dev/null; then
  echo -e "${YELLOW}  pnpm not found — installing...${NC}"
  npm install -g pnpm
fi

NODE_VER=$(node --version)
PNPM_VER=$(pnpm --version)
echo -e "${GREEN}  ✓ Node.js ${NODE_VER}  |  pnpm ${PNPM_VER}${NC}"

# ─── Step 2: Install packages ─────────────────────────────────────────────────

echo ""
echo -e "${BOLD}[2/3] Installing packages...${NC}"

cd "$(dirname "${BASH_SOURCE[0]}")"
pnpm install 2>&1 | tail -5

echo -e "${YELLOW}  Building better-sqlite3 native module...${NC}"
BSQ3=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1)
if [ -z "$BSQ3" ]; then
  echo -e "${RED}  ✗ better-sqlite3 not found in node_modules${NC}"
  exit 1
fi
# Run prebuild-install (downloads prebuilt binary for this platform/Node version)
if (cd "$BSQ3" && node_modules/.bin/prebuild-install 2>&1 | tail -5); then
  echo -e "${GREEN}  ✓ better-sqlite3 native module ready${NC}"
else
  # Fallback: compile from source with node-gyp
  echo -e "${YELLOW}  Prebuilt binary not found — compiling from source...${NC}"
  if command -v node-gyp &>/dev/null; then
    (cd "$BSQ3" && node-gyp rebuild --release 2>&1 | tail -10) \
      && echo -e "${GREEN}  ✓ Compiled successfully${NC}" \
      || { echo -e "${RED}  ✗ Compile failed. Run: apt-get install -y python3 make g++${NC}"; exit 1; }
  else
    echo -e "${RED}  ✗ node-gyp not found. Run: npm install -g node-gyp${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}  ✓ All packages ready${NC}"

# ─── Step 3: Configuration ────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}[3/3] Configuration${NC}"

if [ -f "$ENV_FILE" ]; then
  # .env exists — load it silently and skip all prompts
  echo -e "  ${GREEN}✓ Found existing .env — loading saved credentials${NC}"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  # First run — ask for everything
  echo -e "  ${YELLOW}First run detected — please enter your credentials${NC}"
  echo ""

  echo -e "${BOLD}── Pterodactyl Panel ──────────────────────────────────────────${NC}"
  ask "Panel URL (e.g. https://panel.example.com)" PTERODACTYL_URL ""
  ask "Client API Key (Account → API Credentials)" PTERODACTYL_API_KEY "" true
  ask "Server ID (short ID from panel URL, e.g. 1a2b3c4d)" PTERODACTYL_SERVER_ID ""

  echo ""
  echo -e "${BOLD}── Telegram Account ───────────────────────────────────────────${NC}"
  echo -e "  ${YELLOW}Get API_ID and API_HASH from: https://my.telegram.org → App API${NC}"
  ask "API ID (numbers only)" TELEGRAM_API_ID ""
  ask "API Hash" TELEGRAM_API_HASH "" true
  ask "Phone number (with country code, e.g. +1234567890)" TELEGRAM_PHONE ""

  # Write .env
  echo ""
  echo -e "  Saving credentials to ${ENV_FILE}..."

  cat > "$ENV_FILE" <<EOF
# ── Pterodactyl ─────────────────────────────────────────────────────────
PTERODACTYL_URL=${PTERODACTYL_URL}
PTERODACTYL_API_KEY=${PTERODACTYL_API_KEY}
PTERODACTYL_SERVER_ID=${PTERODACTYL_SERVER_ID}

# ── Telegram (MTProto user account) ─────────────────────────────────────
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
TELEGRAM_PHONE=${TELEGRAM_PHONE}
EOF

  echo -e "${GREEN}  ✓ Credentials saved — future runs will load automatically${NC}"
fi

# ─── Launch ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║            Starting backup bot...            ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}• Backs up: worlds + plugins every 5 minutes${NC}"
echo -e "  ${CYAN}• Sends to: Telegram Saved Messages (up to 2 GB)${NC}"
echo -e "  ${CYAN}• Keeps: exactly 1 backup at a time in Saved Messages${NC}"
echo ""
echo -e "  ${YELLOW}First run will ask for your Telegram OTP code.${NC}"
echo -e "  ${YELLOW}After login the session is saved — no OTP on restart.${NC}"
echo ""

cd "$(dirname "${BASH_SOURCE[0]}")"
exec pnpm --filter @workspace/scripts run backup-bot
