#pragma once

#include <stdbool.h>
#include <stdint.h>

#define MD_NUM_BOARDS 3

/** Denotes individual CTRL-MINI-MD board status.
 * All errors are irrecoverable (needs system reset).
 */
typedef enum {
  MD_OK = 0,

  // board probably doesn't exist (didn't respond to SPI or invalid response
  // during initialization). all commands to the board will be ignored.
  MD_NO_BOARD = 1,

  // board has correct chip, but says motor is not connected (open load).
  MD_NO_MOTOR = 2,

  // board was working, but chip reported overtemperature and turned off.
  MD_OVERTEMP = 3,

  // board was working, but chip responded in SPI unexpectedly and in unknown state.
  // off.
  MD_SPI_ERROR = 4,
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
 */
bool check_stall(uint8_t md_index);
