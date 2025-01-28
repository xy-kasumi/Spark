# CTRL-MINI-ED (r1) Builder Manual

This doc is for people who want to build, modify, test ED board.
Current it's written for r1 (r0 didn't have any such doc).

## Assembly

You'll need the following
* PCBA-ed board
* heatsink
* 12V fan (2pin, XH connector)
* thermal sheet with electric isolation
* plastic M3 screw x2
* 220mΩ resistor & wire
* NTC 100kΩ free-hanging thermistor

Using these parts, you need to attach everything in one thermal block.

The termistor should be secured especially firmly,
because over-temperature protection depends on the thermistor reading.

The diode and the transistor's back plate may or may not be High-V.
Better to treat them as High-V, and apply isolation.
That way touching heatsink won't electrocute you.


## Test procedures

(Before tests)
Install external parts: current sense resistor, thermistor, heatsink, fan, Pico 2.

You should execute test groups sequentially. (i.e. execute _noconn only after _nofw is PASS)
Some tests don't make sense, or even dangerous, without preceding test groups.

### _nofw (No firmware)
Connect to 36V supply.

Tests:
* _nofw_led: LEDs = OFF
* _nofw_smoke: No smoke, max temp in thermography < 70℃ (Tamb<30℃) after 1 min
* _nofw_fan: fan = ON
* _nofw_pow: Power line voltages are nominal for:
  * _nofw_pow_uc: 5±0.5V (TP6), 3.3±0.5V (TP7)
  * _nofw_pow_dchg: 12±1V (TP5), 36±2V (TP26), 100±3V (TP25)
* _nofw_curr: Board current draw = 0.08±0.01A
* _nofw_out: GRINDER, WORK, TOOL = High-Z

### _nohost (No host connection)
Install firmware.

Tests:
* _nohost_led: Status LED = ON, Power LED = OFF
* _nohost_smoke: No smoke, max temp in thermography < 70℃ (Tamb<30℃) after 1 min

### _host (Host connection)
Connect to host. Host must be able to read/write registers.

Tests:
* _host_temp: Read TEMPERATURE. Must be within 5 degrees of Tamb.
* _host_pol1: Write 1 to POLARITY. Relay switch sound, PWR(red)=ON, T=100V, W=0V, G=High-Z
* _host_pol2: Write 2 to POLARITY. Relay switch sound, PWR(red)=ON, T=0V, W=100V, G=High-Z
* _host_pol3: Write 3 to POLARITY. Relay switch sound, PWR(red)=ON, T=100V, W=High-Z, G=0V
* _host_pol4: Write 4 to POLARITY. Relay switch sound, PWR(red)=ON, T=0V, W=0V, G=100V
* _host_pol0: Write 0 to POLARITY. Relay switch sound, PWR(red)=OFF, T=High-Z, W=High-Z, G=High-Z


## Calibrations and other tweaks


## Real world measurements
Measurement procedures during actual EDM.

### _pulse
Prepare CTRL-MINI-ED, host controller, work & tool in operation fluid.

Trigger:
  M_GATE
  CURR_GATE
  CURR_DETECT
Current:
Voltage:

