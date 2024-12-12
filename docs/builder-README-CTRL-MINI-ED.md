# CTRL-MINI-ED Builder Manual

This doc is for people who want to build, modify, test ED board.
Current it's written for r1 (r0 didn't have any such doc).


## Test procedures

(Before tests)
Install external parts: current sense resistor, thermistor, heatsink, fan.

You should execute test groups sequentially. (i.e. execute _noconn only after _nofw is PASS)
Some tests don't make sense, or even dangerous, without preceding test groups.

### _nofw (No firmware)
Connect to 36V supply.

Tests:
* _nofw_led: LEDs = OFF
* _nofw_smoke: No smoke, no hot regions in thermal image
* _nofw_fan: fan = ON
* _nofw_pow: Power line voltages are nominal for:
  * _nofw_pow_uc: 1.1V, 3.3V
  * _nofw_pow_dchg: 18V, 24V, 36V, 100V
* _nofw_curr: Board current draw = (TBD) A
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


### _
