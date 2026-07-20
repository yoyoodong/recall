#!/bin/zsh
set -e

echo "Checking Recall local helper..."
curl -s http://127.0.0.1:8787/health
echo ""
echo "Done."
echo ""
read "reply?Press Enter to close..."
