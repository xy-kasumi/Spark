#!/bin/bash

echo "Building dashboard..."

# Validate TypeScript first (without emitting files)
echo "Validating TypeScript..."
if ! tsc --noEmit; then
    echo "TypeScript validation failed. Aborting build."
    exit 1
fi

# Clean dist directory
mkdir -p dist
rm -rf dist/*

# Transpile source files
echo "Transpiling TypeScript..."
tsc

# Copy HTML and CSS files
echo "Copying static files..."
cp index.html dist/
cp pure-min.css dist/
cp vue.global.js dist/

echo "Build complete! Output in dist/"
echo "To serve, e.g.: cd dist && python3 -m http.server 8000"