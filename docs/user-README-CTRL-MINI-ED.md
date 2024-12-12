# CTRL-MINI-ED User Manual

This doc is for users for CTRL-MINI-ED board.
Basically a datasheet + operating manual.

## Safety warning

Although we put effort to make CTRL-MINI-ED fool-proof,
it's not tested rigorously nor certified to any safety standards.


## Spec

8A

## Usage

## Electrodes

## Status LEDs

Two LEDs.

* Status (white):
* Power (red): indicates that electrodes are potentially energized

Even after sudden power failure, electrodes should be High-Z if power red is OFF.

## Controlling

CTRL-MINI-ED is intended to be used by host board connected via flat cable connector.
The connection contains two things.

* GATE/DETECT pins: trigger a single pulse and detect when current is flowing
* I2C bus: configure pulse strength, get status

Board is configured to be non-zero moderate strength pulse. Thus GATE/DETECT is usable.
I2C is needed to configure it to higher power, or change output polarity or terminals.


### GATE / DETECT interface

### I2C
Can configure:

* 
* Pulse Current
