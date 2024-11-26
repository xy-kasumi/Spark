#pragma once

#include <stdbool.h>
#include <stdint.h>

#define MD_NUM_BOARDS 3
#define MD_STEPS_PER_MM ((float)(256.0 * 100.0))  // 256 microsteps, (maybe) 3.6deg/step, 1mm/rot
#define MD_MM_PER_STEP ((float)(1.0 / MD_STEPS_PER_MM))

/** Denotes individual CTRL-MINI-MD board status.
 * All errors are irrecoverable (needs system reset).
 */
typedef enum {
  MD_OK = 0,

  // board probably doesn't exist (didn't respond to SPI or invalid response
  // during initialization).
  MD_NO_BOARD = 1,

  // board was working, but chip reported overtemperature and turned off.
  MD_OVERTEMP = 2,
} md_board_status_t;

/** Initializes motor driver component. All other functions must be called after
 * this. */
void md_init();

/** Gets board status of specified board (0...MD_NUM_BOARDS-1) */
md_board_status_t md_get_status(uint8_t md_index);

/** Step by one step in either direction. */
void md_step(uint8_t md_index, bool plus);

/**
 * Returns true if motor is stalled by too much force. Useful for end-stop
 * detection. Returns true if stalled.
 *
 * Note it won't return true if motor is disabled by protection like
 * overtemperature, short etc.
 *
 * To make this work, tuning of COOLCONF register in md_init is necessary.
 * i.e. If stall is always detected, check SG_RESULT in DRV_STATUS. If it always
 * 0, decrease sensitivity (increase SGT) in COOLCONF.
 */
bool md_check_stall(uint8_t md_index);

/* Read TMC2130 register directly.
This could be potentially dangerous when used to R+C register which clears its
content upon read.*/
uint32_t md_read_register(uint8_t md_index, uint8_t addr);

/* Write TMC2130 register directly.
This is very dangerous operation that can break the driver internal state,
and also can destroy the hardware if used incorrectly.*/
void md_write_register(uint8_t md_index, uint8_t addr, uint32_t data);
