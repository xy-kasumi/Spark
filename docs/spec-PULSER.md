# PULSER r2 PCB Spec / Cheatsheet for Firmware Developer

This document specifies the PCB hardware interface needed for firmware development,
to meet the requirements defined in [user-PULSER.md](user-PULSER.md).


## Conditions to consider

* Host is not working
  * Control connector is disconnected
  * Host turned off, blank firmware, initializing
* Thermistor wire is broken

Firmware must map these state to well-defined safe behavior.

## uC Overview

uC is Raspberry Pi Pico 2 board.
* [Pico 2 board datasheet](https://datasheets.raspberrypi.com/pico/pico-2-datasheet.pdf)
* [RP2350 chip datasheet](https://datasheets.raspberrypi.com/rp2350/rp2350-datasheet.pdf)

uC operating environment
* 5V 1A powered, regulated down from 12V power
* System clock: 150 MHz
* Firmware write via 3-pin QI connector SWD interface

## uC Connections

| Pin  | Pin Feature  | Connected to   | Note                                             |
|------|--------------|----------------|--------------------------------------------------|
| GP0  | I2C0 SDA     | I2C_SDA        | to host; pulled up to 3.3V by 10kΩ on PCB        |
| GP1  | I2C0 SCL     | I2C_SCL        | to host; pulled up to 3.3V by 10kΩ on PCB        |
| GP2  | GPIO (IN)    | GATE           | to host; direct                                  |
| GP3  | -            | -              | -                                                |
| GP4  | GPIO (OUT)   | LED_STATUS     | white LED, digital H = ON                        |
| GP5  | -            | -              | -                                                |
| GP6  | GPIO (OUT)   | MUX_V0H        | Controls bridge driver V0 (high-side)            |
| GP7  | GPIO (OUT)   | MUX_V0L        | Controls bridge driver V0 (low-side)             |
| GP8  | GPIO (OUT)   | MUX_VCH        | Controls bridge driver Vcom (high-side)          |
| GP9  | GPIO (OUT)   | MUX_VCL        | Controls bridge driver Vcom (low-side)           |
| GP10 | GPIO (OUT)   | MUX_V1H        | Controls bridge driver V1 (high-side)            |
| GP11 | GPIO (OUT)   | MUX_V1L        | Controls bridge driver V1 (low-side)             |
| GP12 | -            | N/C            | -                                                |
| GP13 | -            | N/C            | -                                                |
| GP14 | I2C1 SDA     | TS_I2C_SDA     | Temp sensor chip I2C                             |
| GP15 | I2C1 SCL     | TS_I2C_SCL     | Temp sensor chip I2C                             |
| GP16 | -            | N/C            | -                                                |
| GP17 | GPIO (OUT)   | GATE_IG        | Controls bridge driver for ignition voltage.     |
| GP18 | PWM1A (OUT)  | GATE_MAIN_PWM  | Controls buck converter gate                     |
| GP19 | -            | N/C            | -                                                |
| GP20 | -            | N/C            | -                                                |
| GP21 | -            | N/C            | -                                                |
| GP22 | -            | N/C            | -                                                |
| GP26 | ADC0         | CURR_DETECT    | Current sense chip                               |
| GP27 | -            | N/C            | -                                                |
| GP28 | -            | N/C            | -                                                |

* N/C: No Connection

### Gate input filter
Since correctness of GATE is critical and it's used in noisy environment,
it should employ noise-filtering. (i.e. only detect change if the value persists for more than 1us).


### Pulse generation (GATE_IG, GATE_MAIN_PWM, CURR_DETECT)

Normal operation sequence:
* 0. setup mux
* 1. enable GATE_IG, wait for ignition by monitoring CURR_DETECT
* 2. in parallel:
 * 2.a shutdown GATE_IG after some fixed time (e.g. 10us)
 * 2.b start buck converter, control PWM frequency by monitoring CURR_DETECT

If the ignition time is too short, consider it as short-circuit and don't start buck converter.
Slow GATE_IG shutdown doesn't break anything; rather it just increases time to recover 100V voltage.
Fast GATE_IG means less 100V capacity wasted, but risks premature shutdown of discharge.

Buck converter
* PWM frequency: 500kHz (2us)
* Maximum rate of current change: 36V / 10uH (L4) = 3.6A/us
  * 1% duty: +0.18A/cycle

As there is current sensing delay, PWM duty should start small and change speed should be limited.

#### Current detection

CURR_DETECT is analog output of hole current sensor chip.
ADC Vref is connected to 3.0V reference voltage.
CURR_DETECT is capped by diode to not exceed 3.0V.

* ACS724LLCTR-30AU
* [datasheet](https://www.allegromicro.com/-/media/files/datasheets/acs724-datasheet.ashx)
* "30AU": 0~30A, 133mV/A
* Vout(I=0) = Vcc x 0.1 = 0.5V
* Filter fc=180kHz

Should sample at highest possible ADC resolution to improve current control.

ADC should set PS(GPIO23)=1 to reduce Pico 2 on-board voltage supply ripple.


### Output mux (MUX_*)
Output stage consists of 3 half-bridges.
This enables polarity change & choosing output (work vs grind).

MOSFET driver
* UCC27288
* [datasheet](https://www.ti.com/lit/ds/symlink/ucc27288.pdf)

MOSFETs (both are N-ch)
* BSC110N15NS5
* [datasheet](https://www.infineon.com/dgdl/Infineon-BSC110N15NS5-DataSheet-v02_06-EN.pdf?fileId=5546d46253f650570154a04caaad551a)

* V0 = WORK
* V1 = GRIND
* VC = TOOL

Allowed configuration:

Keep driver active config
| POLARITY   | V0, V1 | VC  |
|------------|--------|-----|
| OFF        | L      | L   |
| TPWN, TPGN | L      | H   |
| TNWP, TNGP | H      | L   |
| Trans      | Z      | Z   |

Turn-off unused config
| POLARITY | V0  | VC  | V1  |
|----------|-----|-----|-----|
| OFF      | L   | L   | L   |
| TPWN     | L   | H   | Z   |
| TNWP     | H   | L   | Z   |
| TPGN     | Z   | H   | L   |
| TNGP     | Z   | L   | H   |
| Trans    | Z   | Z   | Z   |

* L: only enable L
* H: only enable H
* Z: disable both

Any any moment, configurations other than this is disallowed.

OFF is L instead of Z, to properly boot-strap gate driver capacitors.

As mux doesn't need fast switching, transition period should be long (more than 500ns)
to avoid any possibility of shoot-through.

Keep driver active config
* pros: easier to ensure gate driver bootstrap
* cons: might cause uncessary electrolysis

Turn-off unused config
* pros: minimize electrolysis, slightly reduce safety risk
* cons: probably need periodic activation to keep driver boostrapped


### Temperature sensor

TMP102 chip
* [datasheet](https://www.ti.com/lit/ds/symlink/tmp102.pdf)
* I2C connection
* ADD0: V+ (see eratta)
* device address: 1001001 (0x49)

The chip is mounted close to hottest MOSFETs.
We need to determine upper bound of operating condition, and reject to run discharges if exceeded.

Registers are 16bit.
Reg 0x00: temperature (12bit, left-padded, big endian.)

Top 8 bit is signed 8 bit int, temperature in °C.
