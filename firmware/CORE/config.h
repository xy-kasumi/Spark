// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <stdint.h>

#include "hardware/sync.h"

/**
 * Externally observable parameters.
 */
#define LED_INTERVAL_MS 1000
#define LED_FLASH_MS 50

static const uint8_t ED_I2C_ADDR = 0x3b;  // I2C Device Address
static const uint ED_I2C_BAUD = 100000; // I2C target baud (Hz)
static const uint ED_I2C_MAX_TX_US = 1000; // Max time for I2C transaction

#define MD_STEPS_PER_MM ((float)(256.0 * 6.25))  // 256 microsteps, 1.8deg/step, 16teeth, 2mm pitch
#define FEED_MAX_SPEED_MM_PER_S  0.4 // = 24mm/min
#define FEED_MIN_SPEED_MM_PER_S 0.004 // = 0.24mm/min
#define FEED_SPEED_DELTA_MM_PER_S 0.004 // MAX_SPEED and MIN_SPEED must be multiple of this
#define MOVE_SPEED_MM_PER_S 25
#define FIND_SPEED_MM_PER_S 5

/**
 * Auto-computed parameters. Don't edit directly.
 */

#define MD_MM_PER_STEP ((float)(1.0 / MD_STEPS_PER_MM)) // auto-computed

static const uint32_t MD_FEED_MAX_WAIT_US = 1000000 / (FEED_MAX_SPEED_MM_PER_S * MD_STEPS_PER_MM);
static const uint32_t MD_FEED_MIN_WAIT_US = 1000000 / (FEED_MIN_SPEED_MM_PER_S * MD_STEPS_PER_MM);
static const uint32_t MD_FEED_DELTA_WAIT_US = 1000000 / (FEED_SPEED_DELTA_MM_PER_S * MD_STEPS_PER_MM);
static const uint32_t MD_MOVE_WAIT_US = 1000000 / (MOVE_SPEED_MM_PER_S * MD_STEPS_PER_MM);
static const uint32_t MD_FIND_WAIT_US = 1000000 / (FIND_SPEED_MM_PER_S * MD_STEPS_PER_MM);

/**
 * GPIO pin definitions & internal parts-specific parameters.
 */
static const uint8_t PIN_UART_TX = 0;  // UART0, MUI-RX
static const uint8_t PIN_UART_RX = 1;  // UART0, MUI-TX
static const uint8_t PIN_MD_SCK = 2;   // SPI0
static const uint8_t PIN_MD_SDI = 3;   // SPI0
static const uint8_t PIN_MD_SDO = 4;   // SPI0
static const uint8_t PIN_ED_I2C_SDA = 6;    // I2C1
static const uint8_t PIN_ED_I2C_SCL = 7;    // I2C1
static const uint8_t PIN_ED_GATE = 8;       // GPIO OUT
static const uint8_t PIN_ED_DETECT = 9;     // GPIO IN
static const uint8_t PIN_MD_DIR = 16;      // GPIO OUT
static const uint8_t PIN_MD_STEP0 = 17;    // GPIO OUT
static const uint8_t PIN_MD_STEP1 = 18;    // GPIO OUT
static const uint8_t PIN_MD_STEP2 = 19;    // GPIO OUT
static const uint8_t PIN_MD_CSN0 = 20;     // GPIO OUT
static const uint8_t PIN_MD_CSN1 = 21;     // GPIO OUT
static const uint8_t PIN_MD_CSN2 = 22;     // GPIO OUT

#define MD_SPI spi0
#define ED_I2C i2c1



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
