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
static const uint8_t PIN_LED_POWER = 5;
static const uint8_t PIN_MUX_POL = 8;   // Relay POL control
static const uint8_t PIN_MUX_WG = 9;    // Relay SEL control
static const uint8_t PIN_MUX_EN = 10;   // Relay EN control
static const uint8_t PIN_CURR_TRIGGER = 16;
static const uint8_t PIN_CURR_GATE_PWM = 18;
static const uint8_t PWM_CURR_GATE_PWM = 1;
static const uint8_t PWM_CHAN_CURR_GATE_PWM = PWM_CHAN_A;
static const uint8_t PIN_CURR_THRESH_PWM = 20;
static const uint8_t PWM_CURR_THRESH_PWM = 2;
static const uint8_t PWM_CHAN_CURR_THRESH_PWM = PWM_CHAN_A;
static const uint8_t PIN_TEMP_HS = 26; // ADC0
static const uint8_t ADC_TEMP_HS = 0; // ADC0

#define HOST_I2C i2c0

#define RELAY_MAX_SETTLE_TIME_MS 20 // 15ms + safety buffer
#define DISCHARGE_MAX_SETTLE_TIME_US 5 // PWM delay + MOSFET delay
#define THRESH_MAX_SETTLE_TIME_MS 1 // PWM delay
