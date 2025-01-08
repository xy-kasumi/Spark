# G-code spec

## Axes

Absolute vs. relative is pre-determined. (No support for G90/G91).

Absolute
- X, Y, Z: translation movements
- B, C: rotational movements
- A: tool rotation

Relative
- W: wire-feeder
- D: relative version of A


### Note on tool rotation (D, A axis)

The tool axis is infinite-rotation.
However, it does not "remember" how many rotations it has done.
A axis only remebers phase of rotation, and it must be 0~359.999.

Example 1:
* G1 X50 D3600  ; rotate tool 10 turns while moving to X=50.
* G1 A0 ; no rotation at all (because current absolute rotation is 0)

Also, A-axis takes shortest direction.

Example 2:
* G1 A0
* G1 A350 ; rotates -10 degree (not 350 degree)

If you need to ensure direction of rotation and/or number of turns, you need to use D-axis.


## G codes

* G0: move with interpolation. No discharge.
* G1: move with interpolation. discharge-machine. feed rate is auto-controlled by servo.


## M codes

* M100: fill tank (stalls until tank is full)
* M101: drain tank (stalls until tank is empty)
* M102: turn on continuous filtering (instant)
* M103: turn off continuous filtering (instant)
