SHELL = /bin/bash
SCRIPT_DIR = $(CURDIR)
PROJECT_ROOT = $(abspath $(SCRIPT_DIR)/..)
EMSDK_DIR = $(SCRIPT_DIR)/emsdk
OUTPUT_DIR = $(PROJECT_ROOT)/dist/wasm
DEPS_DIR = $(SCRIPT_DIR)/deps
MANIFOLD_DIR = $(DEPS_DIR)/manifold
MANIFOLD_BUILD_DIR = $(MANIFOLD_DIR)/build_wasm
EMSDK_VERSION = 3.1.51
MANIFOLD_VERSION = v3.2.1
WASM_DEBUG_FLAGS = \
	-s ASSERTIONS=2 \
	-s SAFE_HEAP=1 \
	-s STACK_OVERFLOW_CHECK=1

.PHONY: all
all: $(OUTPUT_DIR)/wasm_geom.wasm $(OUTPUT_DIR)/wasm_geom.js

$(OUTPUT_DIR)/wasm_geom.wasm $(OUTPUT_DIR)/wasm_geom.js: $(SCRIPT_DIR)/entrypoint.cpp $(MANIFOLD_BUILD_DIR)/src/libmanifold.a | $(OUTPUT_DIR)
	@echo "=== Compiling WASM ==="
	EMSDK_QUIET=1 source $(EMSDK_DIR)/emsdk_env.sh && emcc $(SCRIPT_DIR)/entrypoint.cpp \
		--no-entry \
		-s ENVIRONMENT=web \
		-s MODULARIZE=1 \
		-s EXPORT_NAME=WasmGeomModule \
		-s EXPORT_ES6=1 \
		-s EXPORTED_RUNTIME_METHODS='["getValue", "setValue", "UTF8ToString"]' \
		-o $(OUTPUT_DIR)/wasm_geom.js \
		-I$(MANIFOLD_DIR)/include \
		-I$(MANIFOLD_BUILD_DIR)/_deps/glm-src \
		-I$(MANIFOLD_BUILD_DIR)/_deps/thrust-src \
		-I$(MANIFOLD_BUILD_DIR)/_deps/thrust-src/thrust/cmake \
		-L$(MANIFOLD_BUILD_DIR)/src \
		-L$(MANIFOLD_BUILD_DIR)/_deps/clipper2-build \
		-lmanifold \
		-lClipper2 \
		-std=c++17 \
		-O3 \
		-s EXPORTED_FUNCTIONS='["_project_manifold", "_free_contours", "_subtract_manifolds", "_create_manifold_from_trisoup", "_destroy_manifold", "_manifold_to_trisoup", "_free_triangle_soup_result", "_malloc", "_free"]' \
		-s ALLOW_MEMORY_GROWTH=1 \
		-s NO_FILESYSTEM=1 \
		-fwasm-exceptions \
		$(WASM_DEBUG_FLAGS)

$(MANIFOLD_BUILD_DIR)/src/libmanifold.a: | $(MANIFOLD_DIR) $(EMSDK_DIR)
	@echo "=== Building Manifold library ==="
	mkdir -p $(MANIFOLD_BUILD_DIR)
	cd $(MANIFOLD_BUILD_DIR) && \
		EMSDK_QUIET=1 source $(EMSDK_DIR)/emsdk_env.sh && \
		emcmake cmake .. \
			-DCMAKE_BUILD_TYPE=Release \
			-DMANIFOLD_PAR=OFF \
			-DMANIFOLD_CROSS_SECTION=ON	\
			-DMANIFOLD_JSBIND=ON \
			-DMANIFOLD_PYBIND=OFF \
			-DMANIFOLD_CBIND=OFF \
			-DMANIFOLD_TEST=OFF \
			-DBUILD_SHARED_LIBS=OFF && \
		emmake make -j8

$(MANIFOLD_DIR): | $(DEPS_DIR)
	@echo "=== Downloading Manifold Library ==="
	@echo "Cloning Manifold repository..."
	cd $(DEPS_DIR) && git clone --depth 1 --branch $(MANIFOLD_VERSION) https://github.com/elalish/manifold.git

$(EMSDK_DIR):
	@echo "=== Downloading Emscripten SDK ==="
	@git clone https://github.com/emscripten-core/emsdk.git $(EMSDK_DIR)
	cd $(EMSDK_DIR) && \
		./emsdk install $(EMSDK_VERSION) && \
		./emsdk activate $(EMSDK_VERSION)

$(OUTPUT_DIR):
	mkdir -p $(OUTPUT_DIR)

$(DEPS_DIR):
	mkdir -p $(DEPS_DIR)

.PHONY: install-emsdk
install-emsdk: $(EMSDK_DIR)

.PHONY: install-manifold
install-manifold: $(MANIFOLD_DIR)

.PHONY: build-manifold
build-manifold: $(MANIFOLD_BUILD_DIR)/src/manifold/libmanifold.a

.PHONY: format
format:
	clang-format -i -style=Chromium $(SCRIPT_DIR)/*.cpp

.PHONY: clean
clean:
	rm -rf $(OUTPUT_DIR)
	rm -rf $(MANIFOLD_BUILD_DIR)

.PHONY: clean-all
clean-all: clean
	rm -rf $(EMSDK_DIR)
	rm -rf $(DEPS_DIR)
