#!/bin/bash

set -e

echo "=== WASM Build Script for Manifold Integration ==="

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EMSDK_DIR="$SCRIPT_DIR/emsdk"
OUTPUT_DIR="$PROJECT_ROOT/dist/wasm"
DEPS_DIR="$SCRIPT_DIR/deps"
MANIFOLD_DIR="$DEPS_DIR/manifold"

# Step 1: Ensure Manifold is installed
if [ ! -d "$MANIFOLD_DIR" ]; then
    echo "Installing Manifold..."
    "$SCRIPT_DIR/install-manifold.sh"
fi

# Step 2: Activate Emscripten environment
echo "Activating Emscripten environment..."
source "$EMSDK_DIR/emsdk_env.sh"

# Step 3: Create output directory
mkdir -p "$OUTPUT_DIR"

# Step 4: Build Manifold library first
echo "Building Manifold library for WASM..."
MANIFOLD_BUILD_DIR="$MANIFOLD_DIR/build_wasm"
mkdir -p "$MANIFOLD_BUILD_DIR"
cd "$MANIFOLD_BUILD_DIR"

# Configure with CMake for Emscripten
emcmake cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DMANIFOLD_PYBIND=OFF \
    -DMANIFOLD_CBIND=ON \
    -DMANIFOLD_BUILD_TEST=OFF \
    -DMANIFOLD_PAR=NONE \
    -DBUILD_SHARED_LIBS=OFF

# Build the library
emmake make -j4

# Step 5: Compile our bindings with Manifold
echo "Compiling Manifold WASM bindings..."
cd "$SCRIPT_DIR"

emcc "$SCRIPT_DIR/manifold_entrypoint.cpp" \
    -o "$OUTPUT_DIR/manifold_ops.js" \
    -O2 \
    -I"$MANIFOLD_DIR/src/manifold/include" \
    -I"$MANIFOLD_DIR/src/utilities/include" \
    -I"$MANIFOLD_DIR/src/cross_section/include" \
    -I"$MANIFOLD_DIR/src/polygon/include" \
    -I"$MANIFOLD_DIR/src" \
    -I"$MANIFOLD_BUILD_DIR/src" \
    -L"$MANIFOLD_BUILD_DIR/src/manifold" \
    -L"$MANIFOLD_BUILD_DIR/src/utilities" \
    -L"$MANIFOLD_BUILD_DIR/src/polygon" \
    -L"$MANIFOLD_BUILD_DIR/src/collider" \
    -L"$MANIFOLD_BUILD_DIR/src/cross_section" \
    -lmanifold \
    -lutilities \
    -lpolygon \
    -lcollider \
    -lcross_section \
    -std=c++17 \
    -s EXPORTED_FUNCTIONS='["_manifold_subtract_meshes", "_manifold_union_meshes", "_manifold_intersect_meshes", "_free_triangle_soup_result", "_malloc", "_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "getValue", "setValue", "UTF8ToString"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='ManifoldOpsModule' \
    -s EXPORT_ES6=1 \
    -s ENVIRONMENT='web' \
    -s SINGLE_FILE=0 \
    -s ASSERTIONS=1 \
    -s DEMANGLE_SUPPORT=1 \
    -fexceptions \
    --no-entry

echo "Build complete!"
echo "Output files:"
echo "  - $OUTPUT_DIR/manifold_ops.js"
echo "  - $OUTPUT_DIR/manifold_ops.wasm"