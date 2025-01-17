# Core Assumptions / Hypotheses
By reading this doc, you'll know how much effort you should use when touching various parts of the code.

This document outlines the foundational truths (axioms), important assumptions, and smaller hypotheses that underpin Dicer.
Each has different implications for how "defensive" or "throwaway" we can be when writing code.

* Axioms: Bedrock truths; if wrong, requires complete rewrite. (30 days)
  * Baked into architecture. No defensive coding needed.
* Assumptions: Important but less absolute; affects ~10% of code. (3 days)
  * Be somewhat defensive - these might change later
* Hypotheses: Small details; affects ~1% of code. (a few hours)
  * Safe to discard or rewrite

Current projection: Dicer needs 30 days to reconstruct from scratch with correct assumptions.
This corresponds to 3K~30K lines of code+doc.

## Axioms
* Dicer converts 3D mesh into G-code
* Dicer provides interactive configuration
* Good G-code generation is the main value of Dicer; thus its logic update will never cease
  * "Good G-code": Aligns with Spark machine's goal (versatile, accurate, robust)
  * -> Path generation logic is continuously running "module" with GUI hooks to allow quick visualization & iteration, instead of test-hardened pure geometry library
* EWR (electrode wear ratio) is bounded, and its value can be user-measurable
  * -> This is the premise of path generation logic. Unbounded EWR means machine needs continuous sensing, completely destroying machine design itself.
* Dicing completes within "non-coffee-break" time to keep interactive configuration meaningful
  * Target: 10 seconds typical, 30 seconds max for complex cases
* Dicer runs on Web browser environment
* Dicer does not depend on external servers

## Assumptions
* Dicer consumes STL file as 3D mesh
* Voxel-based representation + SDF volumetric query is "better" than vector representations (e.g. CSG, NURBS, mesh)
  * "Better": Amount of effort to achieve correctness is lower while being fast enough (with WebGPU available)

## Hypotheses
* Not documented (cost of separate documentation outweighs cost of re-writing code)
* e.g. SDF should be passed around as serializable Shape object, instead of a function
