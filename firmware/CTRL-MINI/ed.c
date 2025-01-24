#include "ed.h"

#include "hardware/gpio.h"
#include "hardware/pwm.h"
#include "hardware/spi.h"
#include "pico/stdlib.h"

#include "config.h"

// Discharge current level PWM control
// must be higher than 100kHz because of CTRL-ED filter circuit
//
// Pico2 system clock = 150MHz
// target clock = 300kHz
// -> period: 500 (150MHz / 300kHz)
static const uint32_t DCHG_PWM_PERIOD = 500;

typedef enum {
  ED_UNKNOWN,
  ED_SENSE,
  ED_DISCHARGE,
} ed_mode_t;

/**
 * True if board seems connected during I/O initialization.
 * If false, I/O pins (especially more dangerous discharge ones) are not
 * initialized.
 *
 * All commands must check this, and return immediately if false.
 */
static ed_mode_t mode = ED_UNKNOWN;

void ed_init() {
  //
  // mode (relay)
  gpio_init(CTRL_ED_MODE_PIN);
  gpio_set_dir(CTRL_ED_MODE_PIN, GPIO_OUT);
  gpio_put(CTRL_ED_MODE_PIN, false);  // false = SENSE mode

  sleep_ms(50);  // wait relay to settle, just in case

  //
  // sense
  gpio_init(CTRL_ED_SENSE_GATE_PIN);
  gpio_set_dir(CTRL_ED_SENSE_GATE_PIN, GPIO_OUT);
  gpio_put(CTRL_ED_SENSE_GATE_PIN, false);

  gpio_init(CTRL_ED_SENSE_CURR_PIN);
  gpio_set_dir(CTRL_ED_SENSE_CURR_PIN, GPIO_IN);
  gpio_pull_up(CTRL_ED_SENSE_CURR_PIN);

  sleep_ms(1);  // wait io to settle

  // if ED board is available, SENSE_CURR must be driven low by the board.
  // if high, it means board is not connected.
  if (gpio_get(CTRL_ED_SENSE_CURR_PIN)) {
    mode = ED_UNKNOWN;
    return;
  }

  //
  // discharge control
  gpio_init(CTRL_ED_DCHG_GATE_PIN);
  gpio_set_dir(CTRL_ED_DCHG_GATE_PIN, GPIO_OUT);
  gpio_put(CTRL_ED_DCHG_GATE_PIN, false);

  //
  // discharge PWM
  gpio_init(CTRL_ED_DCHG_TARG_PWM_PIN);
  gpio_set_function(CTRL_ED_DCHG_TARG_PWM_PIN, GPIO_FUNC_PWM);
  uint dchg_slice = pwm_gpio_to_slice_num(CTRL_ED_DCHG_TARG_PWM_PIN);

  //
  // discharge current detect
  gpio_init(CTRL_ED_DCHG_DETECT);
  gpio_set_dir(CTRL_ED_DCHG_DETECT, GPIO_IN);

  pwm_set_wrap(dchg_slice,
               DCHG_PWM_PERIOD - 1);  // counter value is [0, DCHG_PWM_PERIOD-1]

  // initially set to 0 for safety.
  pwm_set_both_levels(
      dchg_slice, 0,
      0);  // in [0, DCHG_PWM_PERIOD] (corresponds to 0%~100% duty)
  pwm_set_enabled(dchg_slice, true);

  mode = ED_SENSE;
}

void ed_set_dchg_current(uint8_t percent) {
  if (percent >= 100) {
    percent = 100;
  }

  uint32_t target_level = percent * DCHG_PWM_PERIOD / 100;
  if (target_level > DCHG_PWM_PERIOD) {
    target_level = DCHG_PWM_PERIOD;
  }
  uint slice = pwm_gpio_to_slice_num(CTRL_ED_DCHG_TARG_PWM_PIN);
  pwm_set_both_levels(slice, target_level, target_level);
}

bool ed_available() {
  return mode != ED_UNKNOWN;
}

void ed_to_discharge() {
  if (mode == ED_UNKNOWN) {
    return;
  }

  gpio_put(CTRL_ED_MODE_PIN, true);
  sleep_ms(50);  // wait relay to settle
  mode = ED_DISCHARGE;
}

void ed_set_current(uint16_t current_ma) {
  if (mode != ED_DISCHARGE) {
    return;
  }
  if (current_ma >= 2000) {
    current_ma = 2000;
  }

  ed_set_dchg_current(current_ma / 20);
  sleep_ms(1);  // wait for stabilize
}

void ed_unsafe_set_gate(bool on) {
  if (mode != ED_DISCHARGE) {
    return;
  }

  gpio_put(CTRL_ED_DCHG_GATE_PIN, on);
}

uint16_t ed_single_pulse(uint16_t pulse_us, uint16_t max_wait_us) {
  if (mode != ED_DISCHARGE) {
    return UINT16_MAX;
  }

  gpio_put(CTRL_ED_DCHG_GATE_PIN, true);  // discharge ON

  // wait for iginition, with timeout
  absolute_time_t t0 = get_absolute_time();
  uint16_t delay;
  while (true) {
    absolute_time_t t1 = get_absolute_time();
    uint16_t elapsed_us = absolute_time_diff_us(t0, t1);

    bool detected = gpio_get(CTRL_ED_DCHG_DETECT);
    if (detected) {
      delay = elapsed_us;
      break;
    }

    if (elapsed_us >= max_wait_us) {
      // pulse didn't happen within timeout. Turn off and return.
      gpio_put(CTRL_ED_DCHG_GATE_PIN, false);  // discharge OFF
      return UINT16_MAX;
    }
  }

  // Pulse started. Wait for pulse duration.
  sleep_us(pulse_us);
  gpio_put(CTRL_ED_DCHG_GATE_PIN, false);  // discharge OFF

  return delay;
}

bool ed_unsafe_get_detect() {
  if (mode != ED_DISCHARGE) {
    return false;
  }
  return gpio_get(CTRL_ED_DCHG_DETECT);
}

void ed_to_sense() {
  if (mode == ED_UNKNOWN) {
    return;
  }

  gpio_put(CTRL_ED_MODE_PIN, false);
  sleep_ms(50);  // wait relay to settle
  mode = ED_SENSE;
}
