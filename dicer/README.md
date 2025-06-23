
## Running Dicer
Run `./build.sh`. This will generate `dist/`.

Serve the `dicer/` or `spark/`. Open `dicer/dist/index.html` in browser.

## Development
Run `./typecheck.sh` to check types correctness w/o touching `dist/`.
Need to run `./build.sh` whenver source files are edited.

### TypeScript Definitions
- `types/qunit.d.ts` - Original QUnit definitions from DefinitelyTyped
- `types/qunit-extensions-v2.d.ts` - Missing QUnit methods from v2
- `types/vendor.d.ts` - Custom .d.ts maintained by us. Aim for max benefit/cost, rather than completeness.
