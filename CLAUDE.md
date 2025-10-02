## Project Decisions
- To future-proof our code, we strive to minimize dependencies on tools and libraries.
- HTML SPAs must not require external websites or CDNs at runtime to operate.

## TypeScript Guidelines
- Do not refer to 1st party code as `any` in TypeScript.
- In TypeScript, use inline export rather than export list, unless you're re-exporting something imported from other modules.

## dicer/ Guidelines
- In dicer, don't use npm or npx; they're unavailable. Use `make` and `make typecheck` (it internally uses raw tsc).
- After making changes, 1. call `make` to verify build passes, 2. call `make format` to auto-format the code.
- For C++ code under wasm/, we use Chromium formatting.

## shell-dashboard/ Guidelines
- Use `npm run build` to build.
- Use design tokens when writing new CSS. Ask me if new design seems to warrant new tokens.
