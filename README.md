

## Directories

* dicer: main software that generates G-code from STL for the machine
* sim-machine:
  * purpose: visually validate G-code, iterate on machine kinematics
* sim-wear: particle-based tool vs work simulation
  * purpose: validate & iterate on "sweep" patterns w/o actual experiments
* sim-3PRR: 3PRR mechanism simulator
  * purpose: validate 3PRR mechanism design

Sims should be independent of each other.
They should actual add net value to the project.
Typically they do so by allowing quicker iteration.

dicer can send G-code directly to sim-machine (if they're served from the same origin),
by using [Broadcast Channel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API).
