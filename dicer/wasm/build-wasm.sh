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

# Step 3.5: Install CGAL dependencies if needed
DEPS_DIR="$SCRIPT_DIR/deps"
if [ ! -d "$DEPS_DIR/CGAL-5.6" ] || [ ! -d "$DEPS_DIR/boost_1_83_0" ]; then
    echo "Installing CGAL dependencies..."
    "$SCRIPT_DIR/install-cgal.sh"
fi

# Step 4: Compile the WASM module
echo "Compiling entrypoint.cpp to WASM with CGAL..."

emcc "$SCRIPT_DIR/entrypoint.cpp" \
    -o "$OUTPUT_DIR/mesh_project.js" \
    -O2 \
    -I"$DEPS_DIR/CGAL-5.6/include" \
    -I"$DEPS_DIR/boost_1_83_0" \
    -std=c++17 \
    -DCGAL_HAS_NO_THREADS \
    -DCGAL_NDEBUG \
    -s EXPORTED_FUNCTIONS='["_project_mesh", "_free_edge_soup", "_malloc", "_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "getValue", "setValue", "UTF8ToString"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='MeshProjectModule' \
    -s EXPORT_ES6=1 \
    -s ENVIRONMENT='web' \
    -s SINGLE_FILE=0 \
    --no-entry

echo "Build complete!"
echo "Output files:"
echo "  - $OUTPUT_DIR/mesh_project.js"
echo "  - $OUTPUT_DIR/mesh_project.wasm"