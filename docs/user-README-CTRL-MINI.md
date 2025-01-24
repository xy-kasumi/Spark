# CTRL-MINI (r0) User Manual

## Basic setup

CTRL-MINI board is
* connected to CTRL-MINI-ED via Type-A (cross) flat cable
* connected to host (typically a PC) via RasPi Probe
  * Use "CR" for both TX/RC line coding
  * baud rate is 115200

## Commands

Over the serial connection to the host, you can type commands and get results.
Also, CTRL-MINI emits logs (like startup log) without command inputs.

* Each command is issued as a single line. No multi-line support.
* `Ctrl-C` or `Ctrl-K` during input: Cancels the current command input.
  * Other Ctrl commands, backspace, arrow keys, delete etc are not supported.

### High-Level Commands

#### `status`
* **Description:** Prints the status of the system.

#### `edparam <pulse_us> <duty>`
* **Description:** Configures the default value of discharge pulse and duty ratio. Will affect `drill` command.
* **Parameter:**
  * `pulse_us`: integer, pulse duration in microseconds (5 o 10000)
  * `duty`: integer, max duty ratio in percent (1 to 50)

#### `move <board_ix> <distance>`
* **Description:** Moves the specified board by a given distance (in millimeters).
* **Parameters:**
  * `board_ix`: 0, 1, or 2
  * `distance`: float (in mm)

#### `find <board_ix> <distance>`
* **Description:** Moves up to a specified distance or until the electrode touches the work.  
  Uses a hot electrode scan and may cause slight damage to the work.
* **Important:** Must be issued after `edon`.
* **Parameters:**
  * `board_ix`: 0, 1, or 2
  * `distance`: float (in mm)

#### `drill <board_ix> <distance>`
* **Description:** Drills by a specified distance. Actual drill depth may be less due to tool wear.
* **Important:** Must be issued after `edon`.
* **Parameters:**
  * `board_ix`: 0, 1, or 2
  * `distance`: float (in mm)


### Motor Driver (MD) Commands

#### `step <board_ix> <step> <wait>`
* **Description:** Steps one motor in one direction at a constant speed.
* **Parameters:**
  * `board_ix`: 0, 1, or 2
  * `step`: integer (can be negative or positive), in microsteps
  * `wait`: integer, wait time in microseconds after each microstep

#### `home <board_ix> <direction> <timeout_ms>`
* **Description:** Moves the motor to the home position (where it stalls).
* **Parameters:**
  * `board_ix`: 0, 1, or 2
  * `direction`: `-` or `+`
  * `timeout_ms`: integer (timeout in milliseconds)

#### `regread <board_ix> <addr>`
* **Description:** Reads a register from the motor driver.
* **Parameters:**
  * `board_ix`: 0, 1, or 2
  * `addr`: hexadecimal value from `00` to `7f`

#### `regwrite <board_ix> <addr> <data>`
* **Description:** Writes to a register on the motor driver.
* **Parameters:**
  * `board_ix`: 0, 1, or 2
  * `addr`: hexadecimal value from `00` to `7f`
  * `data`: hexadecimal value from `00000000` to `ffffffff`

### ED (Electro-Discharge) Commands

#### `edon`
* **Description:** Switches the ED to discharge mode.

#### `edoff`
* **Description:** Switches the ED to sense mode.
