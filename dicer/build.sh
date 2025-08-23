#!/bin/bash

# Parse command line arguments
BUILD_WASM=false
for arg in "$@"
do
    if [ "$arg" = "--all" ]; then
        BUILD_WASM=true
    fi
done

echo "Building dicer..."

# Build WASM module if --all flag is present
if [ "$BUILD_WASM" = true ]; then
    echo "Building WASM module..."
    if [ -f "./wasm/build-wasm.sh" ]; then
        (cd wasm && ./build-wasm.sh)
        if [ $? -ne 0 ]; then
            echo "WASM build failed. Aborting build."
            exit 1
        fi
    else
        echo "Warning: wasm/build-wasm.sh not found, skipping WASM build"
    fi
fi

# Validate TypeScript first (without emitting files)
echo "Validating TypeScript..."
if ! tsc --noEmit; then
    echo "TypeScript validation failed. Aborting build."
    exit 1
fi

# Clean dist directory (preserve specific HTML files and wasm directory for hot-reload)
mkdir -p dist
find dist -type f ! -name "index.html" ! -name "test.html" ! -path "dist/wasm/*" -delete
find dist -type d -empty ! -path "dist/wasm" -delete

# Transpile source files
echo "Transpiling TypeScript..."
tsc

# Copy vendor files to dist
echo "Copying vendor files..."
cp -r vendor/ dist/vendor/

# Copy assets to dist
echo "Copying assets..."
cp -r assets/ dist/assets/

# Copy HTML files (already have correct paths)
echo "Copying HTML files..."
cp index.html test.html dist/

echo "Build complete! Output in dist/"
echo "To serve, e.g.: cd dist && python3 -m http.server 8000"
