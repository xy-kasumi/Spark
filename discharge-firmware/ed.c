#include "ed.h"

#include "hardware/gpio.h"
#include "hardware/spi.h"
#include "pico/stdlib.h"

#include "config.h"

static bool connected = false;

void ed_init() {
  gpio_init(CTRL_ED_MODE_PIN);
  gpio_set_dir(CTRL_ED_MODE_PIN, GPIO_OUT);
  gpio_put(CTRL_ED_MODE_PIN, false);  // false = SENSE mode

  sleep_ms(100);  // wait relay to settle, just in case

  // sense
  gpio_init(CTRL_ED_SENSE_GATE_PIN);
  gpio_set_dir(CTRL_ED_SENSE_GATE_PIN, GPIO_OUT);
  gpio_put(CTRL_ED_SENSE_GATE_PIN, false);

  gpio_init(CTRL_ED_SENSE_CURR_PIN);
  gpio_set_dir(CTRL_ED_SENSE_CURR_PIN, GPIO_IN);
  gpio_pull_up(CTRL_ED_SENSE_CURR_PIN);

  sleep_ms(1);  // wait io to settle

  // if ED board is available, SENSE_CURR must be driven low by the board.
  if (gpio_get(CTRL_ED_SENSE_CURR_PIN)) {
    connected = false;
    return;
  }

  // discharge
  /*
  CTRL_ED_DCHG_TARG_PWM_PIN
  CTRL_ED_DCHG_GATE_PIN
  CTRL_ED_DCHG_DETECT
  */

  connected = true;
}

bool ed_available() {
  return connected;
}
