# Core Assumptions / Hypothesis
By reading this doc, you'll know how much effort you should use when touching various parts of the code.

This document outlines the foundational truths (axioms), important assumptions, and smaller hypotheses that underpin dicer.
Each has different implications for how “defensive” or “throwaway” we can be when writing code.

* Axioms: bedrock truths; if proven wrong, need 100%-rewrite. (30 days)
  * these are baked into the architecture. no defensive coding is needed.
* Assumptions: important but less absolute; rewriting ~10%. (3 days)
  * you should be a bit defensive (these can turn out to be wrong later)
* Hypotheses: small details; rewriting ~1%. (a few hours)
  * you're free to discard or rewrite

Current projection is that dicer's code size will be 30-days of effort to reconstruct from scratch, if we have 100% right assumptions.
This roughly corresponds to 3K~30K lines of code+doc.

## Axioms
* dicer converts 3D mesh into G-code
* dicer provides interactive configuration
* dicer runs on Web browser environment
* dicer does not depend on external servers
* dicing needs to finish fast enough to not cause "coffee break". By being fast enough, interactive configuration stays meaningful.
  * "non-coffee-break-causing": within 10 seconds typically. Max 30 seconds for complex cases.
* good G-code generation is the main value of dicer; thus its logic update will never cease
  * "good G-code": aligns with Spark machine's goal (versatile, accurate, robust)
  * -> path generation logic is continuously running "module" with GUI hooks, instead of being test-hardened pure geometry library
* EWR (electrode wear ratio) is bounded, and its value can be user-meausrable.
  * -> this is the premise of path generation logic. Unbounded EWR means machine needs continuous sensing, completely destroying machine design itself.

## Assumptions
* dicer consumes STL file as 3D mesh
* voxel-based representation + SDF volumetric query is "better" than vector representations (e.g. CSG, NURBS, mesh)
  * "better": amount of effort to achieve correctness is lower while being fast enough (with WebGPU available)

## Hypotheses
* not documented (cost of separate documentation outweigs cost of re-writing code)
* e.g. SDF should be passed around as serializable Shape object, instead of a function
