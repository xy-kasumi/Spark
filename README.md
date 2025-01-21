# Spark

🚧 Under Construction 🚧

Spark is an OSS/OSH desktop EDM tech stack.
It'll bring the ease of 3D printing to fine metal parts.

Maybe. Someday.

## Directories

Directories are roughly divided into two groups.

### Build & Use
* docs: contains assembly manuals and specs
* discharge-board: KiCad files for PCBA
* discharge-firmware: C firmware code for the boards
* dicer: main software that generates G-code from STL for the machine

These are necessary for building, testing, and using the machine.

### Development & Operations
* sim-machine:
  * purpose: visually validate G-code, iterate on machine kinematics
* sim-wear: particle-based tool vs work simulation
  * purpose: validate & iterate on "sweep" patterns without physical experiments
* sim-3PRR: 3PRR mechanism simulator
  * purpose: validate 3PRR mechanism design
* identity: contains project's visual identity such as logo

These are useful resources to further the development of the machine and/or the Spark project.

Simulations should be independent of each other.
They should actually add net value to the project.
Typically they do so by allowing quicker iteration.

dicer can send G-code directly to sim-machine (if they're served from the same origin),
by using [Broadcast Channel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API).

Note: "localhost" and "127.0.0.1" are considered different origins.
