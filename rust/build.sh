#!/usr/bin/env bash
# Build the Rust binary without installing a toolchain: uses the official rust image through Docker.
#   rust/build.sh            -> $TARGET/release/opencode-bridge   (TARGET defaults to ~/.cache/opencode-bridge-rust/target)
# If you have cargo installed, simply run `cargo build --release` in rust/.
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${OPENCODE_BRIDGE_RUST_CACHE:-$HOME/.cache/opencode-bridge-rust}"
mkdir -p "$CACHE/cargo" "$CACHE/target"
if [ "$#" -eq 0 ]; then set -- build --release; fi
docker run --rm -u "$(id -u):$(id -g)" -v "$HERE":/work -v "$CACHE/cargo":/cargo -v "$CACHE/target":/target \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/target -w /work rust:1-slim cargo "$@"
echo "binary: $CACHE/target/release/opencode-bridge"
