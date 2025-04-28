# Using Octopus Pro board for main controller

This doc explain wiring & firmware setup for using Octopus Pro board.

Necessary hardware:
* [BIGTREE TECH Octopus Pro (H273, V1.1) Board](https://biqu.equipment/products/bigtreetech-octopus-pro-v1-0-chip-f446) x1
  * MCU: STM32H723
  * [user guide](https://github.com/bigtreetech/BIGTREETECH-OCTOPUS-Pro/blob/master/BTT_Octopus_pro_EN.pdf)
  * [circuit schematics](https://github.com/bigtreetech/BIGTREETECH-OCTOPUS-Pro/blob/master/Hardware/BIGTREETECH%20Octopus%20Pro%20V1.1-sch.pdf)
  * [pins](https://github.com/bigtreetech/BIGTREETECH-OCTOPUS-Pro/blob/master/Hardware/BIGTREETECH%20Octopus%20Pro%20-%20PIN.pdf)
* TMC2209 stepper drivers x7

## Wiring

![wiring photo](./octopus-wire.png)

Power Input

* MOTOR_POWER: +12V PSU
* MB_POWER: +24V PSU
* BED_POWER: N/C

Stepper Motor

* Motor DIP
  * Comm mode: Set all 8 to "UART Mode"
  * Power: Use "Motor Power"
* Motor board: Insert TMC2209 boards (x7) in motor 0~6.
* Motor 0,1,2,3,4,5: X,Y,Z,A,B,C respectively
* Motor 6: Wire feeder

Other DIP

* MCU Power Jumper: Remove (Use MB_POWER insterad of USB power)

PULSER Connection
* SCL, SDA (J73, 3.3V, shared with an EEPROM. Pulled-up by 4.7k)
  * SCL: PB8, SDA: PB9
  * J73: 3.3V, GND, SCL, SDA
* GATE (J74-pin6, 3.3V)
  * SPI3_NSS: PA15
  * J74: pin6: SPI3_NSS, pin8: GND


### TBD

HE0~3 (24V = MB_POWER)
* Has flywheel diodes
  * can be used for pump control


## Firmware preparation

## Firmware update
