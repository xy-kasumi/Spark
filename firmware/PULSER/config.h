// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "hardware/pwm.h"
#include <stdint.h>

/**
 * Externally observable parameters.
 */
#define LED_ERR_BLINK_OFF_MS 250
#define LED_ERR_BLINK_ON_MS 250

#define I2C_DEV_ADDR 0x3b  // I2C Device Address
#define I2C_BAUD 400000 // I2C target baud (Hz)

#define MAX_ALLOWED_TEMP 80 // degree celcius

/**
 * GPIO pin definitions & internal parts-specific parameters.
 */
static const uint8_t PIN_I2C_SDA = 0;  // I2C0
static const uint8_t PIN_I2C_SCL = 1;  // I2C0
static const uint8_t PIN_GATE = 2;
static const uint8_t PIN_LED_STATUS = 4;
static const uint8_t PIN_MUX_V0 = 7;  // Controls bridge driver V0
static const uint8_t PIN_MUX_VC = 9;  // Controls bridge driver Vcom
static const uint8_t PIN_TS_I2C_SDA = 14; // Temp sensor chip I2C
static const uint8_t PIN_TS_I2C_SCL = 15; // Temp sensor chip I2C
static const uint8_t PIN_GATE_IG = 17; // Controls bridge driver for ignition voltage
static const uint8_t PIN_GATE_MAIN_PWM = 18; // Controls buck converter gate
static const uint8_t PWM_GATE_MAIN_PWM = 1;
static const uint8_t PWM_CHAN_GATE_MAIN_PWM = PWM_CHAN_A;
static const uint8_t PIN_CURR_DETECT = 26; // ADC0
static const uint8_t ADC_CURR_DETECT = 0; // ADC0
static const uint8_t PIN_POWER_PS = 23;

#define HOST_I2C i2c0
#define TS_I2C i2c1

#define TS_I2C_DEV_ADDR 0x49
#define TS_I2C_TIMEOUT_US 500

#define MUX_MAX_SETTLE_TIME_US 1
#define DISCHARGE_MAX_SETTLE_TIME_US 5 // PWM delay + MOSFET delay
#define THRESH_MAX_SETTLE_TIME_MS 1 // PWM delay
