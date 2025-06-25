# Spark

🚧 Under Construction 🚧

Spark is an OSS/OSH desktop EDM tech stack.
It'll bring the ease of 3D printing to fine metal parts.

Maybe. Someday.

This repo is mostly about software & machine CAD.

To construct a Spark machine, you need these too:
* https://github.com/xy-kasumi/Spark-corefw
  * Zephyr-based firmware for main board (currently only supports BTT Octopus Pro)
* https://github.com/xy-kasumi/Spark-pulser
  * EDM board (PCB design & firmware)

## Directories

Directories are roughly divided into two groups.

### Build & Use
* docs: contains assembly manuals and specs
* dicer: web page that generates G-code from STL for the machine
* shell-dashboard: web page to control the machine
* shell-spooler: Go program that acts as interface between shell-dashboard & physical board
* mech: CAD files for the machine

These are necessary for building, testing, and using the machine.

### Development & Operations
* sim-machine:
  * purpose: visually validate G-code, iterate on machine kinematics
* sim-wear: particle-based tool vs work simulation
  * purpose: validate & iterate on "sweep" patterns without physical experiments
* brand: contains project's visual identity such as logo

These are useful resources to further the development of the machine and/or the Spark project.

Simulations should be independent of each other.
They should actually add net value to the project.
Typically they do so by allowing quicker iteration.

dicer can send G-code directly to sim-machine (if they're served from the same origin),
by using [Broadcast Channel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API).

### Tips
Note: "localhost" and "127.0.0.1" are considered different origins.

When `./build.sh` or `./watch.sh` cause directory listing page to show up;
* If you're using VSCode Live Server, configure "live server wait" to be larger than build time. e.g. 1500 (ms)
