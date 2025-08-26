SHELL = /bin/bash
DIST_DIR = dist
WASM_DIR = wasm
VENDOR_DIR = vendor
ASSETS_DIR = assets

# Find all TypeScript source files
TS_SOURCES = $(shell find src -name "*.ts")
TS_STAMP = $(DIST_DIR)/.ts-compiled

# HTML files to copy
HTML_FILES = index.html test.html

.PHONY: all
all: build

.PHONY: build
build: $(DIST_DIR)/wasm/wasm_geom.js typecheck $(TS_STAMP) $(DIST_DIR)/vendor $(DIST_DIR)/assets $(DIST_DIR)/html-files
	@echo "Build complete! Output in $(DIST_DIR)/"
	@echo "To serve, e.g.: cd $(DIST_DIR) && python3 -m http.server 8000"

.PHONY: typecheck
typecheck:
	@echo "Validating TypeScript..."
	tsc --noEmit

$(DIST_DIR)/wasm/wasm_geom.js:
	@echo "Building WASM module..."
	$(MAKE) -C $(WASM_DIR)

$(TS_STAMP): $(TS_SOURCES) | $(DIST_DIR)
	@echo "Transpiling TypeScript..."
	tsc
	touch $@

$(DIST_DIR)/vendor: $(VENDOR_DIR) | $(DIST_DIR)
	@echo "Copying vendor files..."
	cp -r $(VENDOR_DIR) $(DIST_DIR)/

$(DIST_DIR)/assets: $(ASSETS_DIR) | $(DIST_DIR)
	@echo "Copying assets..."
	cp -r $(ASSETS_DIR) $(DIST_DIR)/

$(DIST_DIR)/html-files: $(HTML_FILES) | $(DIST_DIR)
	@echo "Copying HTML files..."
	cp $(HTML_FILES) $(DIST_DIR)/
	touch $@

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

.PHONY: clean
clean:
	@echo "Removing dist directory..."
	rm -rf $(DIST_DIR)

.PHONY: clean-all
clean-all: clean
	@echo "Removing WASM dependencies..."
	$(MAKE) -C $(WASM_DIR) clean-all