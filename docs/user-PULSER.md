# PULSER (r1) User Manual

This doc is for users of the PULSER board.
It basically serves as both a datasheet and an operating manual.

## ⚠️ Safety warning ⚠️
Improper use of PULSER may cause death, fire, or damage to nearby devices.

## Overview

![photo](./PULSER-r1-photo.jpeg)

PULSER is an EDM discharge board, controllable via digital IOs and I2C.

* Max pulse current: 8A (at duty factor=50%)
* Open voltage: 100V
* 5 dynamic polarity configurations
  * (Tool+, Work-), (Tool-, Work+)
  * (Tool+, Grinder-), (Tool-, Grinder+)
  * Disconnected
* Single-pulse discharge timing control, and pulse current detection via GATE/DETECT digital IOs
* Pulse current, detection threshold, polarity control, temperature monitoring via I2C


### Power Supply
Screw terminal on the left side
* DC 36V, 4.2A minimum

If the power supply is below 4.2 A, the microcontroller might reset accidentally at high-power setting.
Above 4.2 A should be fine, but too much output (e.g. 10 A) will increase the damage in case of firmware bug.

### Indicators

* Status (white) LED: ON if OK. Blinks if error. OFF means hardware or firmware failure.
* Power (red) LED: Indicates that electrodes are potentially energized. Blinks if error.

Even after sudden power failure, electrodes should be in high-impedance state if the Power (red) LED is OFF.
When the board enters an error state, the only way to recover is through a power reset.

### Connections

Control Connector:
* Upright connector for FFC (Flat Flexible Cable)
  * Type-A, pitch 1mm, 8 pins, terminal thickness 0.3mm

Electrodes:
* three screw-terminals on the right side ("Wire", "Grind", "Tool" marking on the PCB)

### Mechanical & Thermal
* Listed values are board with heatsink and fan
* "height", "width" etc. is based on "Spark" logo on the board

**General**
* Outer dimensions: 135mm (width) x 105mm (height) x 50mm (depth)
* Mass: 240g

**Mounting**
Board dimensions: 100mm (width) x 100mm (height)
* 4 mounting holes at (5mm, 5mm), (5mm, 95mm), (95mm, 5mm), (95mm, 95mm)
* Hole dia: 3.3mm, dia available for screw head, spacer etc: 6.5mm
  * available area is either isolated or GND

**Thermal**
* Max heat generation: 75W
  * Ensure adequate airflow at the bottom of the PCB for proper fan operation.


## Controller Interface

PULSER is designed to be safe (de-energized) to be turned on with "Control Connector" disconnected.

### Physical layer
"Control Connector" pinout (at **host-side**. See note.):
1. Don't Connect
2. GND
3. Don't Connect
4. I2C SDA
5. Don't Connect
6. I2C SCL
7. GATE
8. DETECT

Note: Type-A (terminals on same-side) means cross-cable. Thus, pinout at host and PULSER board is flipped.

* I2C SDA/SCL: 3.3V I/O. Standard Mode (~100kHz). Pulled-up in PULSER board.
* GATE: 3.3V digital input
* DETECT: 3.3V digital output


### I2C layer

* Device Address: 0x3B
* Speed: Standard Mode (~100kHz clock)

Within the device, there are registers with 1-byte address and 1-byte data.
Write command writes to a single register, Read command read from a single register.

They involve internal pointer. They don't auto-increment.

**Write**
* M: START
* M: Device Addr (7bit; 0x3B) + Write flag (1bit; 0)
* S: ACK
* M: Register Addr (8bit)
* S: ACK
* M: Data (8bit)
* S: ACK
* M: STOP

This also sets the internal pointer to Register Addr.

**Read**
(write pointer)
* M: START
* M: Device Addr (7bit; 0x3B) + Write flag (1bit; 1)
* S: ACK
* M: Register Addr (8bit)
* S: ACK
(read data from pointer)
* M: Repeated START
* M: Device Addr (7bit; 0x3B) + Read flag (1bit; 1)
* S: Data (8bit)
* M: NACK
* M: STOP

(M: master, S: slave)


### Logical layer

### GATE/DETECT
The host can initiate a single pulse by setting GATE to HIGH.
If the discharge condition is good, discharge will happen after a random Tig (ignition time).
Tig is inherently random, but typically ranges from 10μs to 500μs, and becomes shorter if the gap is narrower.

If DETECT becomes HIGH very quickly (within 5μs), it is highly likely that the discharge gap is short-circuited.
In that case, the host should set GATE to LOW immediately.

Generally, GATE can be thought of as directly driving the MOSFET gate. However, for safety and device longevity,
actual driving can be suppressed. See the "Timing wrt. GATE/DETECT" section for details.

DETECT becomes HIGH whenever discharge current is detected.
The host is responsible for monitoring DETECT and setting GATE to LOW after the desired pulse duration time.
The current detection threshold is auto-set to 25% of pulse current by the PULSER board.

When POLARITY or PULSE_CURRENT is updated, DETECT can become LOW even when actual discharge
current is still flowing.

![photo](./PULSER-GD-signal-timing.png)

There is a constraint for combinations of pulse time, pulse current, and duty factor.
See the "Pulse Shaping" section for details.

Safety note: electrodes are **energized even when GATE is LOW**

Setting GATE to LOW merely means turning down the current close to 0.
However, open voltage of 100V is still present on the electrodes,
and the driver will allow more than 10mA current to flow, which is enough to kill you.

To actually turn them off, you need to set POLARITY to OFF.


### Control Registers
|Address| Register      | Access | Resets to | Description |
|-------|---------------|--------|-----------|-------------|
| 0x01  | POLARITY      | RW     | 0         | 0: OFF, 1~4: energize with certain polarity. |
| 0x02  | PULSE_CURRENT | RW     | 10        | pulse current in 100mA step. 1 (100mA) ~ 80 (8A) is allowed. |
| 0x03  | TEMPERATURE   | R      | N/A       | current heatsink temperature in ℃. 80 means 80℃. 255 means temp reading is unavailable due to severe issue. |

Register access:
* RW: read-write
* R: read-only

Invalid value writes are:
* set to safe default such as OFF (e.g. POLARITY)
* set to nearest valid value (e.g. PULSE_CURRENT)
* ignored for read-only or unused registers (e.g. TEMPERATURE)

#### Timing wrt. GATE/DETECT

Writes to POLARITY & PULSE_CURRENT immediately updates the register.
However, when register is changed during GATE is HIGH,
* change will take effect from the next pulse (once GATE become LOW)
* actual EDM driver will be suppressed for 1ms (PULSE_CURRENT change) and 20ms (POLARITY change)
  * this will lead to very large observed DETECT from the host

As an exception to the delay above, setting POLARITY to OFF immediately shutdown EDM driver.


#### POLARITY

* 0: OFF
* 1: TPWN (Tool+, Work-)
* 2: TNWP (Tool-, Work+)
* 3: TPGN (Tool+, Grinder-)
* 4: TNGP (Tool-, Grinder+)


### Pulse Shaping

Pulse current is limited due to the internal capacitor bank.
* Always: Ip <= 8A (enforced by register)
* When Ip >= 4A: Tp <= 8mC / Ip
  * Tp (max) = 1ms @ Ip = 8A
  * Tp (max) = 1.3ms @ Ip = 6A
* When Ip >= 4A: Ip * DF <= 4A
  * DF (max) = 50% @ Ip = 8A

If DF or pulse duration exceeds these values, discharge current will dwindle to 4A (power supply current) or cause an abrupt voltage drop.

The PULSER board driver is optimized for EDM. It uses a combination of:
* 100V low-capacity "ignition supply"
* 36V high-capacity "discharge supply"

This is possible because the gap voltage, once ignited, becomes about 20V (up to ~30V, depending on conditions).
This dual supply driver is power-efficient but produces unexpected behavior when connected to non-discharging loads.
