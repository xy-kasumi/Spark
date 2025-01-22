# CTRL-MINI-ED Builder Manual

This doc is for people who want to build, modify, test ED board.
Current it's written for r1 (r0 didn't have any such doc).

## Assembly

You'll need the following
* PCBA-ed board
* heatsink
* 12V fan (2pin, XH connector)
* thermal sheet with electric isolation
* isolating M3 screw
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

### _noconn (No host connection)
Install firmware.

Tests:
* _noconn_led: Status LED = ON, Power LED = OFF
* _noconn_smoke: No smoke, no hot regions in thermal image
* _noconn_pow: repeat _nofw_pow
* _noconn_curr: Board current draw = (TBD) A
* _noconn_conn: Connector pin voltages
  * GND = 0 V
  * I2C_SCL, I2C_SDA = 3.3 V
  * DCHG_GATE, DCHG_DETECT = 0 V

### _conn

Tests:
* TBD: something about GATE,DETECT with no I2C (default setting)
* TBD: something about I2C output configuration
* TBD: something to measure current with different pulse config
* TBD: something about rejecting dangerous values
* TBD: something about measuring wave form with fake/real load

* I can just cowboy all the way; what will I regret? (for not testing)
 * if it looks like it's working
 * if it's mysterious
 * if it breaks

If I don't regret, I don't need those tests.

Basically, for Spark progress, I need
* Good MRR, TWR for known materials (esp AL)
* Verify low-current ignition concept
  * Otherwise, we need to rework ED soon
* Verify different pulse settings are possible
  * to plan other expriments
* Verify touch detection with small current
* Safety of long-runs, temeprature monitoring works. Try stopping fan.

With these, I'll move towards mechanical design & CAM.
I won't touch pulse current shaping any time soon.



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

