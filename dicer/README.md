
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

## Internals & Definitions
All coordinate systems are right-handed.

* "setup coordinates"
  * what users see in dicer.
  * Z+ is up. XY-center is stock profile center.
    * stock is always extrusion of a an XY-aligned profile in Z direction.
    * e.g. cylinder (circle in XY extruded in Z), bar (rectangle in XY extruded in Z)
  * Target shape resides in Z+ half-space, "resting" on XY-plane.
* "work coodinates"
  * same as [G55 work coordinate](https://github.com/xy-kasumi/Spark-corefw/blob/main/spec/gcode.md#g55-use-work-coordinate-system)
  * origin is chuck base center
  * stock resides in X- direction
    * profile is mostly YZ-center aligned, but might have offset depending on chuck types

Dicer computes paths in setup coordinates, and then convert them to work coordinates when emitting G-code.

Setup coordinates and work coordinates shares Y+ axis direction.
