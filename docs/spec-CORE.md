# CORE (r0) PCB Spec / Cheatsheet for Firmware Developer

This document specifies the PCB hardware interface needed for firmware development,
to meet the requirements defined in [user-CORE.md](user-CORE.md).


## Conditions to consider

* Some STPDRV boards are unavailable
* PULSER board is unavailable

Firmware must map these states to well-defined safe behaviors.

## uC Overview

The uC is a Raspberry Pi Pico 2 board.
* [Pico 2 board datasheet](https://datasheets.raspberrypi.com/pico/pico-2-datasheet.pdf)
* [RP2350 chip datasheet](https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf)

uC operating environment
* 5V 1A powered, regulated down from 12V main power
* System clock: 150 MHz
* Firmware write via 3-pin QI connector SWD interface

## uC Connections

| Pin  | Pin Feature   | Connected to     | Note                                                               |
|------|---------------|------------------|--------------------------------------------------------------------|
| GP0  | UART0 TX      | MUI-RX           | RasPi probe (serial) |
| GP1  | UART0 RX      | MUI-TX           | RasPi probe (serial) |
| GP2  | SPI0 SCK      | MD (all)         | |
| GP3  | SPI0 SDI      | MD (all)         | |
| GP4  | SPI0 SDO      | MD (all)         | |
| GP5  | -             | ED Conn Pin 3    | N/C (r2), GND (r3) |
| GP6  | I2C1 SDA      | ED Conn Pin 4    | I2C SDA (r2, r3) |
| GP7  | I2C1 SCL      | ED Conn Pin 6    | I2C SCL (r2, r3) |
| GP8  | GPIO (OUT)    | ED Conn Pin 7    | GATE (r2, r3) |
| GP9  | GPIO (IN)     | ED Conn Pin 8    | N/C (r2), GND (r3) |
| GP10 | -             | N/C              | |
| GP11 | -             | N/C              | |
| GP12 | -             | N/C              | |
| GP13 | -             | N/C              | |
| GP14 | -             | N/C              | |
| GP15 | -             | N/C              | |
| GP16 | GPIO (OUT)    | MD (all) DIR     | |
| GP17 | GPIO (OUT)    | MD (0) STEP      | |
| GP18 | GPIO (OUT)    | MD (1) STEP      | |
| GP19 | GPIO (OUT)    | MD (2) STEP      | |
| GP20 | GPIO (OUT)    | MD (0) CSN       | |
| GP21 | GPIO (OUT)    | MD (1) CSN       | |
| GP22 | GPIO (OUT)    | MD (2) CSN       | |
| GP26 | -             | ED Conn Pin 5    | N/C (r2), GND (r3) |
| GP27 | -             | N/C              | |
| GP28 | -             | N/C              | |

* N/C: No Connection

STPDRV r0, PULSER r1 is assumed.
PULSER r0 pin notes are left for historical reference.


## STPDRV boards

The STPDRV board is a 14-pin child board, taking 3.3V logic power and 12V power input.

Each STPDRV board has:
* A single TMC2130 stepper driver motor
* On-PCB configuration jumpers for:
  * Phase current (0.2A vs 0.4A)
  * Power voltage (5V vs 12V)

They're controlled by SPI & "STEP/DIR" interface.
SPI bus connects uC and 3 STPDRV boards.

To address each chip individually, CSN pins are used.
CSNs are GPIO pins, so firmware needs to manually toggle them when doing SPI transactions.

# PULSER board

Nothing is done in PULSER. Just a direct connection.
See [user-PULSER.md](user-PULSER.md) for details.
