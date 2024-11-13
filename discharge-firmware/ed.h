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
