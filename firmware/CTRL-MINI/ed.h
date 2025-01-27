#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Initializes discharge component. All other functions must be called after
 * this. */
void ed_init();

/** Returns if ED board is available or not. If false, all other commands will
 * be ignored for safety. */
bool ed_available();

void ed_set_energize(bool on);

void ed_set_current(uint16_t current_ma);

void ed_unsafe_set_gate(bool on);

bool ed_unsafe_get_detect();

/**
 * Apply single pulse. Wait for certain amount of time (a few msec) until pulse
 * starts.
 *
 * max_wait_us: maximum wait time for pulse to start. 5000 (5ms) is a good
 * value.
 *
 * returns:
 * ignition delay time (time between gate on and pulse start), in microsec.
 * UINT16_MAX if pulse didn't happen.
 */
uint16_t ed_single_pulse(uint16_t pulse_us, uint16_t max_wait_us);
