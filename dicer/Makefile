SHELL = /bin/bash
DIST_DIR = dist

# Find all TypeScript source files
TS_SOURCES = $(shell find src -name "*.ts")
TS_STAMP = $(DIST_DIR)/.ts-compiled

# HTML files to copy
HTML_SOURCES = index.html test.html
HTML_TARGETS = $(addprefix $(DIST_DIR)/,$(HTML_SOURCES))

.PHONY: all
all: build

.PHONY: build
build: typecheck $(DIST_DIR)/wasm/wasm_geom.js $(TS_STAMP) $(DIST_DIR)/vendor $(DIST_DIR)/assets $(HTML_TARGETS)
	@echo "Build complete! Output in $(DIST_DIR)/"
	@echo "To serve, e.g.: cd $(DIST_DIR) && python3 -m http.server 8000"

.PHONY: typecheck
typecheck:
	@echo "Validating TypeScript..."
	tsc --noEmit

$(DIST_DIR)/wasm/wasm_geom.js: wasm/entrypoint.cpp
	@echo "Building WASM module..."
	$(MAKE) -C wasm

$(TS_STAMP): $(TS_SOURCES)
	@echo "Transpiling TypeScript..."
	mkdir -p $(DIST_DIR)
	tsc
	touch $(TS_STAMP)

$(DIST_DIR)/vendor: vendor
	@echo "Copying vendor files..."
	mkdir -p $(DIST_DIR)
	cp -r vendor $(DIST_DIR)/

$(DIST_DIR)/assets: assets
	@echo "Copying assets..."
	mkdir -p $(DIST_DIR)
	cp -r assets $(DIST_DIR)/

$(DIST_DIR)/%.html: %.html
	@echo "Copying $<..."
	mkdir -p $(DIST_DIR)
	cp $< $@

.PHONY: clean
clean:
	@echo "Removing dist directory..."
	rm -rf $(DIST_DIR)

.PHONY: clean-all
clean-all: clean
	@echo "Removing WASM dependencies..."
	$(MAKE) -C wasm clean-all