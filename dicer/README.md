
## Running Dicer
Run `make`. This will generate `dist/`. First-time will be slow, as it will download Emscripten SDK & Manifold libarries.

Serve the `dicer/` or `spark/`. Open `dicer/dist/index.html` in browser.

## Development
Run `make typecheck` to check types correctness w/o touching `dist/`.
Need to run `make` whenver source files are edited.

Run `make clean` to remove built files.

Run `make clean-all` to remove SDKs and libraries too.

### TypeScript Definitions
- `types/qunit.d.ts` - Original QUnit definitions from DefinitelyTyped
- `types/qunit-extensions-v2.d.ts` - Missing QUnit methods from v2
- `types/vendor.d.ts` - Custom .d.ts maintained by us. Aim for max benefit/cost, rather than completeness.
