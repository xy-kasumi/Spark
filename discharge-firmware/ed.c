#include "ed.h"

#include "hardware/gpio.h"
#include "hardware/spi.h"
#include "pico/stdlib.h"

#include "config.h"

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
  gpio_init(CTRL_ED_MODE_PIN);
  gpio_set_dir(CTRL_ED_MODE_PIN, GPIO_OUT);
  gpio_put(CTRL_ED_MODE_PIN, false);  // false = SENSE mode

  sleep_ms(50);  // wait relay to settle, just in case

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

  // discharge
  gpio_init(CTRL_ED_DCHG_TARG_PWM_PIN);
  gpio_set_function(CTRL_ED_DCHG_TARG_PWM_PIN, GPIO_FUNC_PWM);

  /*
  CTRL_ED_DCHG_TARG_PWM_PIN
  CTRL_ED_DCHG_GATE_PIN
  CTRL_ED_DCHG_DETECT
  */

  mode = ED_SENSE;
}

bool ed_available() {
  return mode != ED_UNKNOWN;
}

int ed_proximity() {
  const int64_t MAX_WAIT_US = 100 * 1000 * 1000;  // 100s
  if (mode != ED_SENSE) {
    return -1;
  }

  absolute_time_t t0 = get_absolute_time();
  gpio_put(CTRL_ED_SENSE_GATE_PIN, true);

  int delay;
  while (true) {
    // bool sense = gpio_get(CTRL_ED_SENSE_CURR_PIN);
    absolute_time_t t1 = get_absolute_time();

    sleep_us(5);
    gpio_put(CTRL_ED_SENSE_GATE_PIN, false);
    sleep_us(1);
    gpio_put(CTRL_ED_SENSE_GATE_PIN, true);

    delay = absolute_time_diff_us(t0, t1);
    if (delay >= MAX_WAIT_US) {
      break;
    }
  }

  gpio_put(CTRL_ED_SENSE_GATE_PIN, false);
  sleep_us(100);  // wait so that next measurement will be accurate

  return delay;
}

void ed_to_discharge() {
  if (mode == ED_UNKNOWN) {
    return;
  }

  gpio_put(CTRL_ED_MODE_PIN, true);
  sleep_ms(50); // wait relay to settle
  mode = ED_DISCHARGE;
}

void ed_to_sense() {
  if (mode == ED_UNKNOWN) {
    return;
  }

  gpio_put(CTRL_ED_MODE_PIN, false);
  sleep_ms(50); // wait relay to settle
  mode = ED_SENSE;
}
