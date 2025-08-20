#!/bin/bash

set -e

echo "=== Installing CGAL for WebAssembly ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/deps"
CGAL_VERSION="5.6"

# Create deps directory
mkdir -p "$DEPS_DIR"
cd "$DEPS_DIR"

# Download and extract CGAL header-only library
if [ ! -d "CGAL-$CGAL_VERSION" ]; then
    echo "Downloading CGAL $CGAL_VERSION..."
    wget -q "https://github.com/CGAL/cgal/releases/download/v$CGAL_VERSION/CGAL-$CGAL_VERSION-library.tar.xz"
    tar xf "CGAL-$CGAL_VERSION-library.tar.xz"
    rm "CGAL-$CGAL_VERSION-library.tar.xz"
    echo "CGAL $CGAL_VERSION installed"
else
    echo "CGAL $CGAL_VERSION already installed"
fi

# Download Boost headers (required by CGAL)
if [ ! -d "boost_1_83_0" ]; then
    echo "Downloading Boost headers..."
    wget -q "https://boostorg.jfrog.io/artifactory/main/release/1.83.0/source/boost_1_83_0.tar.gz"
    tar xzf "boost_1_83_0.tar.gz"
    rm "boost_1_83_0.tar.gz"
    echo "Boost headers installed"
else
    echo "Boost headers already installed"
fi

echo "Dependencies installed in $DEPS_DIR"
echo ""
echo "CGAL include path: $DEPS_DIR/CGAL-$CGAL_VERSION/include"
echo "Boost include path: $DEPS_DIR/boost_1_83_0"