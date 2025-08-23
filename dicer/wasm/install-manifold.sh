#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/deps"

echo "=== Installing Manifold C++ Library ==="

# Create deps directory if it doesn't exist
mkdir -p "$DEPS_DIR"
cd "$DEPS_DIR"

# Clone Manifold repository if not already present
if [ ! -d "manifold" ]; then
    echo "Cloning Manifold repository..."
    git clone --depth 1 --branch v2.5.1 https://github.com/elalish/manifold.git
else
    echo "Manifold already exists at $DEPS_DIR/manifold"
fi

echo "Manifold installation complete!"