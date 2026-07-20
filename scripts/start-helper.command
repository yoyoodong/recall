#!/bin/zsh
set -e

cd "$(dirname "$0")/.."

echo "Starting Recall local helper..."
echo "API: http://127.0.0.1:8787"
echo ""

if [ ! -f ".env" ]; then
  echo "Missing .env. Please copy .env.example to .env and fill your Feishu Base config first."
  echo ""
  read "reply?Press Enter to close..."
  exit 1
fi

node server/index.js
