#!/bin/bash

set -e

echo "=== WASM Build Script for Mesh Projection ==="

# Configuration
EMSDK_VERSION="3.1.51"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EMSDK_DIR="$SCRIPT_DIR/emsdk"
OUTPUT_DIR="$PROJECT_ROOT/dist/wasm"

# Step 1: Download and setup Emscripten if not present
if [ ! -d "$EMSDK_DIR" ]; then
    echo "Downloading Emscripten SDK..."
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    cd "$EMSDK_DIR"
    ./emsdk install $EMSDK_VERSION
    ./emsdk activate $EMSDK_VERSION
    cd "$SCRIPT_DIR"
else
    echo "Emscripten SDK already exists at $EMSDK_DIR"
fi

# Step 2: Activate Emscripten environment
echo "Activating Emscripten environment..."
source "$EMSDK_DIR/emsdk_env.sh"

# Step 3: Create output directory
mkdir -p "$OUTPUT_DIR"

# Step 3.5: Install and build Manifold if needed
DEPS_DIR="$SCRIPT_DIR/deps"
if [ ! -d "$DEPS_DIR/manifold" ]; then
    echo "Installing Manifold..."
    "$SCRIPT_DIR/install-manifold.sh"
fi

MANIFOLD_BUILD_DIR="$DEPS_DIR/manifold/build_wasm"
if [ ! -f "$MANIFOLD_BUILD_DIR/src/manifold/libmanifold.a" ]; then
    echo "Building Manifold library..."
    mkdir -p "$MANIFOLD_BUILD_DIR"
    cd "$MANIFOLD_BUILD_DIR"
    emcmake cmake .. \
        -DCMAKE_BUILD_TYPE=Release \
        -DMANIFOLD_PYBIND=OFF \
        -DMANIFOLD_CBIND=OFF \
        -DMANIFOLD_BUILD_TEST=OFF \
        -DMANIFOLD_PAR=NONE \
        -DBUILD_SHARED_LIBS=OFF
    emmake make -j4
    cd "$SCRIPT_DIR"
fi

# Step 4: Compile the WASM module
echo "Compiling entrypoint.cpp to WASM with Manifold..."

emcc "$SCRIPT_DIR/entrypoint.cpp" \
    -o "$OUTPUT_DIR/mesh_project.js" \
    -O2 \
    -I"$DEPS_DIR/manifold/src/manifold/include" \
    -I"$DEPS_DIR/manifold/src/utilities/include" \
    -I"$DEPS_DIR/manifold/src/cross_section/include" \
    -I"$DEPS_DIR/manifold/src/polygon/include" \
    -I"$DEPS_DIR/manifold/build_wasm/_deps/glm-src" \
    -I"$DEPS_DIR/manifold/build_wasm/_deps/thrust-src" \
    -I"$DEPS_DIR/manifold/build_wasm/_deps/thrust-src/thrust/cmake" \
    -L"$MANIFOLD_BUILD_DIR/src/manifold" \
    -L"$MANIFOLD_BUILD_DIR/src/polygon" \
    -L"$MANIFOLD_BUILD_DIR/_deps/clipper2-build" \
    -lmanifold \
    -lpolygon \
    -lClipper2 \
    -std=c++17 \
    -DTHRUST_DEVICE_SYSTEM=THRUST_DEVICE_SYSTEM_CPP \
    -s EXPORTED_FUNCTIONS='["_project_mesh", "_free_edge_soup", "_manifold_subtract_meshes", "_free_triangle_soup_result", "_malloc", "_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "getValue", "setValue", "UTF8ToString"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='MeshProjectModule' \
    -s EXPORT_ES6=1 \
    -s ENVIRONMENT='web' \
    -s SINGLE_FILE=0 \
    -s ASSERTIONS=2 \
    -s SAFE_HEAP=1 \
    -s STACK_OVERFLOW_CHECK=1 \
    -s DEMANGLE_SUPPORT=1 \
    -s NO_DISABLE_EXCEPTION_CATCHING=1 \
    -fexceptions \
    --no-entry

echo "Build complete!"
echo "Output files:"
echo "  - $OUTPUT_DIR/mesh_project.js"
echo "  - $OUTPUT_DIR/mesh_project.wasm"