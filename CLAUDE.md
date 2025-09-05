## Project Decisions
- To future-proof our code, we don't use npm, node, or any bulder. We strive to minimize dependencies.
- HTML SPAs must not reference external websites or CDNs at runtime.

## TypeScript Guidelines
- Do not refer to 1st party code as `any` in TypeScript.
- In TypeScript, use inline export rather than export list, unless you're re-exporting something imported from other modules.

## dicer/ Guidelines
- In dicer, don't use npm or npx; they're unavailable. Use `make` and `make typecheck` (it internally uses raw tsc).
- After making changes, 1. call `make` to verify build passes, 2. call `make format` to auto-format the code.
- For C++ code under wasm/, we use Chromium formatting.

## shell-dashboard/ Guidelines
- In dashboard, don't use npm or npx; they're unavailable. Use `./typecheck.sh` and `./build.sh` (internally calls raw tsc).

