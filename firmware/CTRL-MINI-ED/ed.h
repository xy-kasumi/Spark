#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Initializes discharge component. All other functions must be called after
 * this. */
void ed_init();

/** Returns if ED board is available or not. If false, all other commands will
 * be ignored for safety. */
bool ed_available();

/**
 * Returns "proximity" value. This is actually a delay in SENSE_CURR rise.
 * Needs to be called after ed_to_sense().
 */
int ed_proximity();

void ed_to_discharge();

void ed_to_sense();

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

/**
 * Output pulse periodically, while sweeping current PWM from 0% to 100%.
 * Repeat that for numsteps times.
 */
void ed_test_sweep(uint32_t numsteps);

/**
 * Disconnect relay while gate is on.
 * Must be in discharge mode.
 * This call will transition ed to sense mode.
 *
 * WILL SHORTEN RELAY LIFE.
 */
void ed_test_hot_disconnect();
