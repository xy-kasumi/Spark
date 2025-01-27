# CTRL-MINI-ED (r0) PCB Spec / Cheatsheet for Firmware Developer

This document specifies the PCB hardware interface needed for firmware development,
to meet the requirements defined in [user-README-CTRL-MINI.md](user-README-CTRL-MINI.md).


## Conditions to consider

* MD boards are (partially) unavailable
* ED board is unavailable

Firmware must map these state to well-defined safe behavior.

## uC Overview

uC is Raspberry Pi Pico 2 board.
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
| GP5  | GPIO (OUT)    | ED/MODE          | Pin 3 in ED Control Connector |
| GP6  | GPIO (OUT)    | ED/SENSE_GATE    | Pin 4 in ED Control Connector |
| GP7  | GPIO (OUT)    | ED/DCHG_TARG_PWM | Pin 6 in ED Control Connector |
| GP8  | GPIO (OUT)    | ED/DCHG_GATE     | Pin 7 in ED Control Connector |
| GP9  | GPIO (IN)     | ED/DCHG_DETECT   | Pin 8 in ED Control Connector |
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
| GP26 | ADC3          | ED/SENSE_CURR    | Pin 5 in ED Control Connector |
| GP27 | -             | N/C              | |
| GP28 | -             | N/C              | |

* N/C: No Connection

MD r0, ED r0 is assumed.


## MD boards

MD board is a 14-pin child board, taking 3.3V logic power and 12V power input.

Each MD board has:
* single TMCxxxx stepper driver motor
* on-PCB configuration jumper (phase current (0.2A vs 0.4) and power voltage (5V vs 12V))

They're controlled by SPI & "STEP/DIR" interface.
SPI is connect to uC in bus fashion.

To address each chip individually, CSN pins are used.
CSNs are GPIO, so fw need to manually toggle them when doing SPI transaction.

# ED board

Nothing is done in CTRL-MINI. Just a direct connection.
See [user-README-CTRL-MINI-ED.md](user-README-CTRL-MINI-ED.md) for details.
