# License Overview

Each top-level directory contains a `LICENSE` file with the full text. Below is a summary:

> **Note:** Some files are licensed by 3rd parties. See respective file comments and [3rd party credits](#3rd-party-credits) for details.  
> If there is any discrepancy between this summary and a directory’s `LICENSE` file, the latter takes precedence.

| Directory     | License               | Description                                          |
|---------------|-----------------------|------------------------------------------------------|
| `dicer`       | AGPL-3.0-or-later     | G-code generator for the Spark machine               |
| `firmware`    | AGPL-3.0-or-later     | 3D printer firmware                                  |
| `pcb`         | CERN-OHL-S-2.0        | PCB files in KiCad                                   |
| `mech` (TBD)  | CERN-OHL-S-2.0        | Mechanical CAD files                                 |
| `docs`        | CC BY-SA 4.0          | Hardware/software specs & manuals                    |
| `brand`       | CC BY-NC-ND 4.0       | Project logos and other identity assets              |
| `sim-*` dirs  | Apache-2.0            | Various simulators                                   |

## Core Parts
`dicer`, `firmware`, `pcb`, and `docs` are essential parts of Spark machine and its build/use,
thus considered core to the Spark project.
They use strong copyleft licenses (AGPL or CERN-OHL) to ensure improvements remain open.
We believe this approach has worked well in the 3D printer ecosystem.

AGPL, CERN-OHL, and Apache-2.0 also include *patent retaliation* clauses, promoting non-hostile behavior as the ecosystem grows.

## Identity
`brand` contains Spark’s logos and other visual identity materials. They are licensed under CC BY-NC-ND 4.0 to maintain the Spark Project identity.

## 3rd Party Credits
| Component           | License          | Link                                                    |
|---------------------|------------------|---------------------------------------------------------|
| three.js            | MIT              | <https://github.com/mrdoob/three.js>                    |
| N8AO                | CC0 1.0          | <https://github.com/N8python/n8ao>                      |
| WebGPU-Radix-Sort   | MIT              | <https://github.com/kishimisu/WebGPU-Radix-Sort>        |
| Source Sans 3       | SIL OFL 1.1      | <https://fonts.google.com/specimen/Source+Sans+3>       |
| lil-gui             | MIT              | <https://github.com/georgealways/lil-gui>               |
| vue.js              | MIT              | <https://github.com/vuejs/vue>                          |
| pure-css            | BSD-3-Clause     | <https://github.com/pure-css/pure/>                     |
| qunit               | MIT              | <https://github.com/qunitjs/qunit>                      |
| cq-electronics      | MIT              | <https://github.com/sethfischer/cq-electronics>         |

Also see [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) for full details.
