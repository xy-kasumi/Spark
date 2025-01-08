# G-code spec

## Axes

Absolute vs. relative is pre-determined. (No support for G90/G91).

Absolute
- X, Y, Z: translation movements
- B, C: rotational movements
- A: tool rotation

Relative
- GW: grinder wire feed length
- D: relative version of A


### Note on tool rotation (D, A axis)

The tool axis is infinite-rotation.
However, it does not "remember" how many rotations it has done.
A axis only remebers phase of rotation, and it must be 0~359.999.

Example 1:
```
G1 X50 D3600  ; rotate tool 10 turns while moving to X=50.
G1 A0 ; no rotation at all (because current absolute rotation is 0)
```

Also, A-axis takes shortest direction.

Example 2:
```
G1 A0
G1 A350 ; rotates -10 degree (not 350 degree)
```

If you need to ensure direction of rotation and/or number of turns, you need to use D-axis.


## G codes

* G0: move with interpolation. No discharge.
* G1: move with interpolation. discharge-machine. feed rate is auto-controlled by servo.
* G28: auto-home all (X, Y, Z, C) axis

## M codes

* M3 WV[voltage] PT[duration] PI[current] DF[duty-factor-percent]: energize tool-work (de-energize others)
  * M3 WV100 ; applies +100V to work (with reference to tool)
  * M3 WV-100 ; applies -100V to work (with reference to tool)
  * M3 WV100 PT500 PI8 DF75 ; applies +100V to work, pulse duration 500us, pulse current 8A. duty factor 75%.
  * only 100 and -100 is supported. other values will be treated as 100 or -100.
* M4 GV[voltage] PT[duration] PI[current] DF[duty-factor-percent]: energize grinder-tool (de-energize others)
  * M4 GV100 ; applies +100V to grinder (with reference to tool)
  * M4 GV-100 ; applies -100V to grinder (with reference to tool)
  * only 100 and -100 is supported. other values will be treated as 100 or -100.
* M5: de-energize everything

Note for M3, M4 commands. Voltage is relative among tool, work, and grinder wire. They're not voltage from Earth.
Unless de-energized (M5), none of them is safe to touch regardless of voltage value.

* M16 [model_name]
  * Check if model_name matches current machine.
  * Aborts print if not matches (printer can chose to emulate, but it's generally not worth it)
  * model_name must be `[a-zA-Z0-9-.]+`
  * e.g. `M16 SPARK-WG1`

* M100: fill tank (stalls until tank is full)
* M101: drain tank (stalls until tank is empty)
* M102: turn on continuous filtering (instant)
* M103: turn off continuous filtering (instant)

## Reservation for future use

`+#,_` are explicitly reserved for future use, and should not be used anywhere.
This especially applies to M-codes, where parameters are much more flexible than G-codes.
