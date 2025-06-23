## Project Decisions
- To future-proof our code, we don't use npm, node, or any bulder. We strive to minimize dependencies.
- HTML SPAs must not reference external websites or CDNs at runtime.

## TypeScript Guidelines
- Do not refer to 1st party code as `any` in TypeScript.