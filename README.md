# Spark

🚧 Under Construction 🚧

Spark is an OSS/OSH desktop EDM tech stack.
It'll bring the ease of 3D printing to fine metal parts.

Maybe. Someday.

This repo is mostly about software & machine CAD.

To construct a Spark machine, you need these too:
* https://github.com/xy-kasumi/Spark-corefw
  * firmware for main board (currently only supports BTT Octopus Pro)
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

* sim-wear: particle-based tool vs work simulation
  * purpose: validate & iterate on "sweep" patterns without physical experiments
* brand: contains project's visual identity such as logo

These are useful resources to further the development of the machine and/or the Spark project.

### Tips
Note: "localhost" and "127.0.0.1" are considered different origins.

When `./build.sh` or `./watch.sh` cause directory listing page to show up:
* Configure `liveServer.settings.wait` to be larger than build time. e.g. 1500 (ms)

When log output from spooler is causing refresh:
* Add `"**/logs/**"` to `liveServer.settings.ignoreFiles`.
