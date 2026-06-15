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

echo -e "${BOLD}[1/4] Checking dependencies...${NC}"

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
echo -e "${BOLD}[2/4] Installing packages...${NC}"

cd "$(dirname "${BASH_SOURCE[0]}")"
pnpm install --frozen-lockfile 2>&1 | tail -5

echo -e "${YELLOW}  Rebuilding native modules (better-sqlite3)...${NC}"
cd scripts && npm rebuild better-sqlite3 --silent 2>&1 | tail -3 && cd ..
echo -e "${GREEN}  ✓ All packages installed${NC}"

# ─── Step 3: Collect configuration ───────────────────────────────────────────

echo ""
echo -e "${BOLD}[3/4] Configuration${NC}"
echo -e "  ${YELLOW}Leave blank to keep existing value shown in [brackets]${NC}"
echo ""

# Load existing values if .env exists
if [ -f "$ENV_FILE" ]; then
  echo -e "  ${GREEN}Found existing .env — using saved values as defaults${NC}"
  echo ""
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Pterodactyl
echo -e "${BOLD}── Pterodactyl Panel ──────────────────────────────────────────${NC}"
ask "Panel URL (e.g. https://panel.example.com)" PTERODACTYL_URL "${PTERODACTYL_URL:-}"
ask "Client API Key (Account → API Credentials)" PTERODACTYL_API_KEY "${PTERODACTYL_API_KEY:-}" true
ask "Server ID (short ID from panel URL, e.g. 1a2b3c4d)" PTERODACTYL_SERVER_ID "${PTERODACTYL_SERVER_ID:-}"

echo ""
# Telegram
echo -e "${BOLD}── Telegram Account ───────────────────────────────────────────${NC}"
echo -e "  ${YELLOW}Get API_ID and API_HASH from: https://my.telegram.org → App API${NC}"
ask "API ID (numbers only)" TELEGRAM_API_ID "${TELEGRAM_API_ID:-}"
ask "API Hash" TELEGRAM_API_HASH "${TELEGRAM_API_HASH:-}" true
ask "Phone number (with country code, e.g. +1234567890)" TELEGRAM_PHONE "${TELEGRAM_PHONE:-}"

echo ""
# Optional session (skip OTP on restart)
echo -e "${BOLD}── Session (optional) ─────────────────────────────────────────${NC}"
echo -e "  ${YELLOW}If you have a saved session string, paste it here to skip OTP${NC}"
echo -e "  ${YELLOW}Leave blank on first run — session will be saved automatically${NC}"
ask "Session string (leave blank for first run)" TELEGRAM_SESSION "${TELEGRAM_SESSION:-}"

# ─── Step 4: Write .env ───────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}[4/4] Saving configuration to ${ENV_FILE}...${NC}"

cat > "$ENV_FILE" <<EOF
# ── Pterodactyl ─────────────────────────────────────────────────────────
PTERODACTYL_URL=${PTERODACTYL_URL}
PTERODACTYL_API_KEY=${PTERODACTYL_API_KEY}
PTERODACTYL_SERVER_ID=${PTERODACTYL_SERVER_ID}

# ── Telegram (MTProto user account) ─────────────────────────────────────
TELEGRAM_API_ID=${TELEGRAM_API_ID}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
TELEGRAM_PHONE=${TELEGRAM_PHONE}

# ── Session (auto-filled after first login — do not edit manually) ───────
TELEGRAM_SESSION=${TELEGRAM_SESSION}
EOF

echo -e "${GREEN}  ✓ Saved to ${ENV_FILE}${NC}"

# ─── Launch ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║         Setup complete — starting bot        ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}• Backs up: worlds + plugins every 5 minutes${NC}"
echo -e "  ${CYAN}• Sends to: Telegram Saved Messages (up to 2 GB)${NC}"
echo -e "  ${CYAN}• Keeps: exactly 1 backup at a time in Saved Messages${NC}"
echo -e "  ${CYAN}• Upload: 16 parallel connections for max speed${NC}"
echo ""
echo -e "  ${YELLOW}First run will ask for your Telegram OTP code.${NC}"
echo -e "  ${YELLOW}After login the session is saved — no OTP on restart.${NC}"
echo ""

cd "$(dirname "${BASH_SOURCE[0]}")"
exec pnpm --filter @workspace/scripts run backup-bot
