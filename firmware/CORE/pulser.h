// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

/** Initializes discharge component. All other functions must be called after
 * this. */
void pulser_init();

/** Returns if ED board is available or not. If false, all other commands will
 * be ignored for safety. */
bool pulser_available();

/**
 * Write current ED state to the specified buffer.
 * It won't contain newlines.
 */
void pulser_dump_state(char* ptr, size_t size);

/**
 * Returns tmperature (degree Celsius) of the board.
 * Returns 255 if temperature reading was not possible.
 */
uint8_t pulser_temp();

/**
 * Set polarity to ON or OFF.
 * Wait until polarity change is complete.
 */
void pulser_set_energize(bool on);

/**
 * Set specified pulse current.
 * Wait until current change is complete.
 */
void pulser_set_current(uint16_t current_ma);

void pulser_unsafe_set_gate(bool on);

bool pulser_unsafe_get_detect();

/**
 * Read single byte from the specified register.
 * Returns 0 if read failed.
 */
uint8_t pulser_read_register(uint8_t reg_addr);

/**
 * Write single byte to the specified register.
 */
void pulser_write_register(uint8_t reg_addr, uint8_t data);

