#!/usr/bin/env bash
# Recompile src/policy/bundle.wasm from src/policy/rego/main.rego.
# Requires opa CLI (https://www.openpolicyagent.org/docs/latest/#1-download-opa).
# Only needs to be run when the .rego source changes — the compiled artifact is
# committed to the repo so normal builds do not require opa to be installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
REGO_DIR="$PROJECT_ROOT/src/policy/rego"
OUT_WASM="$PROJECT_ROOT/src/policy/bundle.wasm"
TMP_BUNDLE="$(mktemp /tmp/mc8yp-policy-XXXXXX.tar.gz)"

echo "Compiling OPA policy to WASM..."
opa build -t wasm -e mc8yp/transaction/decision -o "$TMP_BUNDLE" "$REGO_DIR"

echo "Extracting policy.wasm..."
TMP_DIR="$(mktemp -d)"
tar -xzf "$TMP_BUNDLE" -C "$TMP_DIR"
cp "$TMP_DIR/policy.wasm" "$OUT_WASM"
rm -rf "$TMP_DIR" "$TMP_BUNDLE"

echo "Done: $OUT_WASM ($(wc -c < "$OUT_WASM") bytes)"
