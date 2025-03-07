// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <stdint.h>

#include "hardware/sync.h"

/**
 * Externally observable parameters.
 * Parameters are ordered by frequency of adjustment needed (most frequently
 * adjusted parameters first).
 */

// MD_MICROSTEP & MD_STEPS_PER_MM should result in resolution of 5um or less.
// But too little and CORE cannot drive pulse fast enough (slows down movement).
// must be power of 2 between 1 and 256.
#define MICROSTEP 32

// 200 step/rot (1.8 deg/step) / (16 teeth * 2mm pitch)
#define STEPS_PER_MM ((float)(MICROSTEP * 6.25))

#define FEED_MAX_SPEED_MM_PER_S 0.5
#define FIND_SPEED_MM_PER_S 5

// mainly constarained by mass & friction (vs. motor driving capability)
#define MAX_ACC_MM_PER_S2 500

// mainly constrained by motor pulse-torque characteristics & safety
// (current motor can go 500, but reduced for safety)
#define MAX_SPEED_MM_PER_S 25

// Set this so that CONTROL_LOOP_INTERVAL_US becomes an integer.
#define CONTROL_LOOP_HZ 1000

// I2C Device Address
static const uint8_t PULSER_I2C_ADDR = 0x3b;
// I2C target baud (Hz)
static const int PULSER_I2C_BAUD = 400000;
// Max time for I2C transaction
static const int PULSER_I2C_MAX_TX_US = 1000;

// Specifies driver chip capability rather than mechanical limit or safety
// limit. Max pulse rate = 1e6 / (MIN_STEP_PULSE_DUR_US * 2).
#define MIN_STEP_DUR_US 1

#define LED_INTERVAL_MS 1000
#define LED_FLASH_MS 50

/**
 * Auto-computed parameters. Don't edit directly.
 */

#define CTRL_DT_US (1000000.0f / CONTROL_LOOP_HZ)
#define CTRL_DT_S (1.0f / CONTROL_LOOP_HZ)
// must be small enough to avoid crippling uC by interrupts
// must be big enough compared to MAX_SPEED_MM_PER_S. Otherwise motion generator
// will malfunction.
#define MAX_STEP_IN_LOOP 25
#define MM_PER_STEP ((float)(1.0 / STEPS_PER_MM))


/**
 * GPIO pin definitions & internal parts-specific parameters.
 */
static const uint8_t PIN_UART_TX = 0;        // UART0, MUI-RX
static const uint8_t PIN_UART_RX = 1;        // UART0, MUI-TX
static const uint8_t PIN_STPDRV_SCK = 2;     // SPI0
static const uint8_t PIN_STPDRV_SDI = 3;     // SPI0
static const uint8_t PIN_STPDRV_SDO = 4;     // SPI0
static const uint8_t PIN_PULSER_I2C_SDA = 6; // I2C1
static const uint8_t PIN_PULSER_I2C_SCL = 7; // I2C1
static const uint8_t PIN_PULSER_GATE = 8;    // GPIO OUT
static const uint8_t PIN_STPDRV_DIR = 16;    // GPIO OUT
static const uint8_t PIN_STPDRV_STEP0 = 17;  // GPIO OUT
static const uint8_t PIN_STPDRV_STEP1 = 18;  // GPIO OUT
static const uint8_t PIN_STPDRV_STEP2 = 19;  // GPIO OUT
static const uint8_t PIN_STPDRV_CSN0 = 20;   // GPIO OUT
static const uint8_t PIN_STPDRV_CSN1 = 21;   // GPIO OUT
static const uint8_t PIN_STPDRV_CSN2 = 22;   // GPIO OUT

#define STPDRV_SPI spi0
#define PULSER_I2C i2c1

#define UART_BAUD 921600

inline static void wait_25ns() {
  // 4 nops, assuming 150MHz
  __nop();
  __nop();
  __nop();
  __nop();
}

inline static void wait_100ns() {
  // 16 nops, assuming 150MHz
  __nop();
  __nop();
  __nop();
  __nop();
  __nop();

  __nop();
  __nop();
  __nop();
  __nop();
  __nop();

  __nop();
  __nop();
  __nop();
  __nop();
  __nop();

  __nop();
}
