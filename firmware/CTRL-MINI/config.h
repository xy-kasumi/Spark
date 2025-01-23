#pragma once

#include <stdint.h>

#include "hardware/sync.h"

#define LED_INTERVAL_MS 1000
#define LED_FLASH_MS 50

/**
 * GPIO pin definitions
 */
static const uint8_t CTRL_ED_MODE_PIN = 5;
static const uint8_t CTRL_ED_SENSE_GATE_PIN = 6;
static const uint8_t CTRL_ED_SENSE_CURR_PIN = 26;
static const uint8_t CTRL_ED_DCHG_TARG_PWM_PIN = 7;
static const uint8_t CTRL_ED_DCHG_GATE_PIN = 8;
static const uint8_t CTRL_ED_DCHG_DETECT = 9;

static const uint8_t CTRL_MD_SCK = 2;  // SPI0
static const uint8_t CTRL_MD_SDI = 3;  // SPI0
static const uint8_t CTRL_MD_SDO = 4;  // SPI0
static const uint8_t CTRL_MD_DIR_PIN = 16;
static const uint8_t CTRL_MD_STEP0_PIN = 17;
static const uint8_t CTRL_MD_STEP1_PIN = 18;
static const uint8_t CTRL_MD_STEP2_PIN = 19;
static const uint8_t CTRL_MD_CSN0_PIN = 20;
static const uint8_t CTRL_MD_CSN1_PIN = 21;
static const uint8_t CTRL_MD_CSN2_PIN = 22;

/**
 * Peripheral configurations
 */
#define MD_SPI spi0

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
