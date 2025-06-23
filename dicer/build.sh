#!/bin/bash
set -e

echo "Building dicer..."

# Clean dist directory (preserve specific HTML files for hot-reload)
mkdir -p dist
find dist -type f ! -name "index.html" ! -name "test.html" -delete
find dist -type d -empty -delete

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
