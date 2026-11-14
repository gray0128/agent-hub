#!/bin/sh
set -eu

HUB_URL="${AHUB_URL:-__HUB_URL__}"
INSTALL_DIR="${AHUB_INSTALL_DIR:-$HOME/.local/bin}"

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "No sha256 tool found (sha256sum, shasum, or openssl required)." >&2
    exit 1
  fi
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET_KEY="${OS}_${ARCH}"
BIN_NAME="ahub-${OS}-${ARCH}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

MANIFEST_PATH="$TMP_DIR/version.json"
BIN_TMP="$TMP_DIR/ahub"

curl -fsSL "${HUB_URL%/}/dl/version.json" -o "$MANIFEST_PATH"
EXPECTED_SHA="$(awk -v key="\"$ASSET_KEY\"" '
  $0 ~ key { found=1 }
  found && /"sha256"/ {
    gsub(/.*"sha256"[[:space:]]*:[[:space:]]*"/, "");
    gsub(/".*/, "");
    print;
    exit
  }
' "$MANIFEST_PATH" | tr -d '[:space:]')"

curl -fsSL "${HUB_URL%/}/dl/${BIN_NAME}" -o "$BIN_TMP"

if [ -n "$EXPECTED_SHA" ]; then
  ACTUAL_SHA="$(sha256_file "$BIN_TMP")"
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "SHA-256 mismatch: expected $EXPECTED_SHA, got $ACTUAL_SHA" >&2
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR"
chmod 0755 "$BIN_TMP"
if [ "$OS" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -cr "$BIN_TMP" 2>/dev/null || true
fi
mv "$BIN_TMP" "$INSTALL_DIR/ahub"
echo "Installed ahub to $INSTALL_DIR/ahub"
