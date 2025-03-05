// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <stdbool.h>
#include <stdint.h>
#define STPDRV_NUM_BOARDS 3

/** Denotes individual STPDRV board status.
 * All errors are irrecoverable (needs system reset).
 */
typedef enum {
  STPDRV_OK = 0,

  // board probably doesn't exist (didn't respond to SPI or invalid response
  // during initialization).
  STPDRV_NO_BOARD = 1,

  // board was working, but chip reported overtemperature and turned off.
  STPDRV_OVERTEMP = 2,
} stpdrv_board_status_t;

/** Initializes motor driver component. All other functions must be called after
 * this. */
void stpdrv_init();

/** Gets board status of specified board (0...STPDRV_NUM_BOARDS-1) */
stpdrv_board_status_t stpdrv_get_status(uint8_t stpdrv_index);

/** Step by one step in either direction. */
void stpdrv_step(uint8_t stpdrv_index, bool plus);

/**
 * Returns true if motor is stalled by too much force. Useful for end-stop
 * detection. Returns true if stalled.
 *
 * Note it won't return true if motor is disabled by protection like
 * overtemperature, short etc.
 *
 * To make this work, tuning of COOLCONF register in stpdrv_init is necessary.
 * i.e. If stall is always detected, check SG_RESULT in DRV_STATUS. If it always
 * 0, decrease sensitivity (increase SGT) in COOLCONF.
 */
bool stpdrv_check_stall(uint8_t stpdrv_index);

/* Read TMC2130 register directly.
This could be potentially dangerous when used to R+C register which clears its
content upon read.*/
uint32_t stpdrv_read_register(uint8_t stpdrv_index, uint8_t addr);

/* Write TMC2130 register directly.
This is very dangerous operation that can break the driver internal state,
and also can destroy the hardware if used incorrectly.*/
void stpdrv_write_register(uint8_t stpdrv_index, uint8_t addr, uint32_t data);
