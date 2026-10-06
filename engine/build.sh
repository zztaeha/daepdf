#!/bin/sh
# Builds src/daegun/wasm/daegun.wasm. Needs rustup (the toolchain is pinned in rust-toolchain.toml)
# and binaryen's wasm-opt.
set -eu
cd "$(dirname "$0")"
# Panic locations name source files; mapped, the binary carries no local paths and builds the same anywhere
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${RUSTUP_HOME:-$HOME/.rustup}=/rustup --remap-path-prefix=$PWD=/engine"
cargo build --release --locked --target wasm32-unknown-unknown
wasm-opt -O3 --strip-debug --strip-producers \
  --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals --enable-multivalue --enable-reference-types \
  target/wasm32-unknown-unknown/release/daepdf_engine.wasm -o ../src/daegun/wasm/daegun.wasm
ls -l ../src/daegun/wasm/daegun.wasm
