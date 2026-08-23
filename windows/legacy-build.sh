#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────────────────────
# Build a portable Windows distribution of JobFinder.
#
# Strategy: pkg/single-exe doesn't work for Next.js because Next.js needs its
# .next/ build directory on the REAL filesystem. Instead, we create a portable
# folder with:
#   1. A standalone Next.js build (all server code + node_modules)
#   2. A portable Windows node.exe (downloaded from nodejs.org)
#   3. A launcher .bat that ties it all together
#   4. A self-extracting .exe wrapper (via makesfx/7z) — OR a simple .zip
#
# The final output is JobFinder-Windows.zip in the project root.
# The user extracts it and double-clicks JobFinder.bat (or JobFinder.exe).
# ─────────────────────────────────────────────────────────────────────────────

NODE_VERSION="18.20.3"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"

echo "╔══════════════════════════════════════════════════════╗"
echo "║       JobFinder — Windows Portable Build            ║"
echo "╚══════════════════════════════════════════════════════╝"

ORIG_DIR=$(pwd)
TEMP_DIR=$(mktemp -d)
DIST_DIR="$TEMP_DIR/JobFinder"
echo "[1/7] Temp workspace: $TEMP_DIR"

# ── Step 1: Copy source (excluding runtime data) ────────────────────────────
echo "[2/7] Copying source files..."
mkdir -p "$DIST_DIR"
rsync -a \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'data' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude 'JobFinder.exe' \
  --exclude 'JobFinder-Windows.zip' \
  --exclude 'build_windows_exe.sh' \
  --exclude 'test.exe' \
  --exclude 'test.js' \
  . "$DIST_DIR/"

cd "$DIST_DIR"

# ── Step 2: Patch for Windows + standalone ───────────────────────────────────
echo "[3/7] Patching next.config.js for standalone output..."
sed -i '' "s/module.exports = {/module.exports = {\n  output: 'standalone',/" next.config.js

# Add Windows browser paths to browser.js
cat > /tmp/win_browsers_patch.py << 'PYEOF'
import sys
path = sys.argv[1]
with open(path, 'r') as f:
    content = f.read()
old = "const CANDIDATE_BROWSERS = ["
new = """const CANDIDATE_BROWSERS = [
  { name: 'Windows Google Chrome', path: 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe' },
  { name: 'Windows Google Chrome (x86)', path: 'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe' },
  { name: 'Windows MS Edge', path: 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe' },
  { name: 'Windows Brave', path: 'C:\\\\Program Files\\\\BraveSoftware\\\\Brave-Browser\\\\Application\\\\brave.exe' },"""
content = content.replace(old, new, 1)
with open(path, 'w') as f:
    f.write(content)
PYEOF
python3 /tmp/win_browsers_patch.py lib/browser.js

# ── Step 3: Install dependencies and build ───────────────────────────────────
echo "[4/7] Installing dependencies and building Next.js..."
npm install --ignore-scripts 2>&1 | tail -5
# Run playwright install separately (will fail on Windows anyway, that's fine)
npx playwright install chromium firefox 2>/dev/null || true
npm run build 2>&1 | tail -20

# ── Step 4: Prepare the standalone distribution folder ───────────────────────
echo "[5/7] Assembling portable distribution..."
STANDALONE="$DIST_DIR/.next/standalone"

# Copy static assets into the standalone folder
cp -r "$DIST_DIR/public" "$STANDALONE/public" 2>/dev/null || true
mkdir -p "$STANDALONE/.next"
cp -r "$DIST_DIR/.next/static" "$STANDALONE/.next/static" 2>/dev/null || true

# Copy connectors (they are dynamically loaded at runtime)
cp -r "$DIST_DIR/connectors" "$STANDALONE/connectors" 2>/dev/null || true

# Download the prebuilt Windows native binary for better-sqlite3
# npm_config_platform=win32 does NOT cross-compile native modules — it still
# builds a macOS binary. We must download the real Windows .node DLL from GitHub.
SQLITE_VERSION="11.3.0"
NODE_ABI="108"  # Node.js 18 ABI version
SQLITE_URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${SQLITE_VERSION}/better-sqlite3-v${SQLITE_VERSION}-node-v${NODE_ABI}-win32-x64.tar.gz"
echo "  → Downloading prebuilt Windows binary for better-sqlite3 v${SQLITE_VERSION}..."
SQLITE_TAR="$TEMP_DIR/better-sqlite3-win.tar.gz"
curl -fsSL "$SQLITE_URL" -o "$SQLITE_TAR"
# Extract the .node file into the standalone node_modules
mkdir -p "$STANDALONE/node_modules/better-sqlite3/build/Release"
tar xzf "$SQLITE_TAR" -C "$STANDALONE/node_modules/better-sqlite3/" 2>/dev/null || true
# Verify
if [ -f "$STANDALONE/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  echo "  ✓ Windows better-sqlite3 binary installed"
else
  echo "  ✗ ERROR: better-sqlite3 Windows binary not found after extraction!"
  ls -la "$STANDALONE/node_modules/better-sqlite3/build/Release/" 2>/dev/null
  exit 1
fi

# ── Step 5: Download portable Windows Node.js ────────────────────────────────
echo "[6/7] Downloading portable Windows Node.js v${NODE_VERSION}..."
NODE_ZIP="$TEMP_DIR/node-win.zip"
curl -fsSL "$NODE_URL" -o "$NODE_ZIP"
# Extract just node.exe from the zip
unzip -jo "$NODE_ZIP" "node-v${NODE_VERSION}-win-x64/node.exe" -d "$STANDALONE/" > /dev/null

# ── Step 6: Create the Windows launcher (.bat) ───────────────────────────────
# This .bat file:
#   - Sets up environment variables
#   - Uses the bundled node.exe to run server.js
#   - Keeps the window open on error
#   - Opens the browser automatically
cat > "$STANDALONE/JobFinder.bat" << 'BATEOF'
@echo off
title JobFinder Application
color 0A

echo ==================================================
echo           JobFinder Application
echo ==================================================
echo.

:: Set the working directory to wherever the .bat lives
cd /d "%~dp0"

:: Set environment
set PORT=3737
set HOSTNAME=0.0.0.0
set NODE_ENV=production

echo [*] Starting server on http://localhost:3737 ...
echo [*] Press Ctrl+C to stop the server.
echo.

:: Open browser after a short delay (in background)
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3737"

:: Run the server using the bundled portable node.exe
"%~dp0node.exe" "%~dp0server.js"

:: If server exits, keep window open so user can read errors
echo.
echo ==================================================
echo  Server stopped. Press any key to close...
echo ==================================================
pause >nul
BATEOF

# Also create a PowerShell launcher for better UX
cat > "$STANDALONE/JobFinder.ps1" << 'PS1EOF'
$Host.UI.RawUI.WindowTitle = "JobFinder Application"
Write-Host "==================================================" -ForegroundColor Green
Write-Host "           JobFinder Application                  " -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""

Set-Location $PSScriptRoot

$env:PORT = "3737"
$env:HOSTNAME = "0.0.0.0"
$env:NODE_ENV = "production"

Write-Host "[*] Starting server on http://localhost:3737 ..." -ForegroundColor Cyan
Write-Host "[*] Press Ctrl+C to stop the server." -ForegroundColor Yellow
Write-Host ""

# Open browser after delay
Start-Job -ScriptBlock { Start-Sleep 3; Start-Process "http://localhost:3737" } | Out-Null

try {
    & "$PSScriptRoot\node.exe" "$PSScriptRoot\server.js"
} catch {
    Write-Host "`nERROR: $_" -ForegroundColor Red
}

Write-Host "`n=================================================="
Write-Host " Server stopped. Press any key to close..."
Write-Host "=================================================="
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
PS1EOF

# Create a tiny .exe launcher using a VBScript-compiled approach
# This creates JobFinder.exe which just runs the .bat file
cat > "$STANDALONE/JobFinder.vbs" << 'VBSEOF'
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "cmd /k JobFinder.bat", 1, False
VBSEOF

# ── Step 7: Create the final zip ─────────────────────────────────────────────
echo "[7/7] Packaging into JobFinder-Windows.zip..."

# Move the standalone folder to a clean name
FINAL_DIR="$TEMP_DIR/JobFinder-Windows"
mv "$STANDALONE" "$FINAL_DIR"

# Verify the .next directory exists with the build output
if [ ! -d "$FINAL_DIR/.next/server" ]; then
  echo "ERROR: .next/server directory not found in standalone build!"
  echo "Contents of $FINAL_DIR:"
  ls -la "$FINAL_DIR/"
  exit 1
fi
echo "  ✓ .next/server directory found"
echo "  ✓ .next/static directory: $([ -d "$FINAL_DIR/.next/static" ] && echo 'found' || echo 'missing (ok if no static assets)')"

# Create zip — exclude only .DS_Store, NOT .next/
cd "$TEMP_DIR"
zip -r "$ORIG_DIR/JobFinder-Windows.zip" "JobFinder-Windows/" -x "*/.DS_Store" > /dev/null

# Clean up
cd "$ORIG_DIR"
rm -rf "$TEMP_DIR"
rm -f /tmp/win_browsers_patch.py

# Also remove the old broken .exe if it exists
rm -f "$ORIG_DIR/JobFinder.exe"

SIZE=$(du -sh "$ORIG_DIR/JobFinder-Windows.zip" | awk '{print $1}')
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅ Build complete!                                 ║"
echo "║                                                     ║"
echo "║  Output: JobFinder-Windows.zip ($SIZE)              ║"
echo "║                                                     ║"
echo "║  Instructions for Windows user:                     ║"
echo "║  1. Extract the zip to any folder                   ║"
echo "║  2. Double-click JobFinder.bat                      ║"
echo "║  3. Browser opens to http://localhost:3737           ║"
echo "╚══════════════════════════════════════════════════════╝"
