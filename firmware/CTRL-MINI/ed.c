#include "ed.h"

#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "pico/stdlib.h"
#include "pico/time.h"

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
  ED_OK, // I2C comm success
} ed_mode_t;

static ed_mode_t mode = ED_UNKNOWN;

void ed_init() {
  gpio_init_mask((1 << PIN_ED_GATE) | (1 << PIN_ED_DETECT) | (1 << PIN_ED_I2C_SCL) | (1 << PIN_ED_I2C_SDA));
  gpio_set_dir(PIN_ED_DETECT, GPIO_IN);
  gpio_pull_down(PIN_ED_DETECT);

  // Init I2C.
  i2c_init(ED_I2C, ED_I2C_BAUD);
  gpio_set_function(PIN_ED_I2C_SDA, GPIO_FUNC_I2C);
  gpio_set_function(PIN_ED_I2C_SCL, GPIO_FUNC_I2C);

  // TODO: do temperature read to check if board is connected.

}

bool ed_available() {
  return mode != ED_UNKNOWN;
}

void ed_set_current(uint16_t current_ma) {
  if (mode != ED_OK) {
    return;
  }
  // TODO: do I2C to set PULSE_CURRENT
}

void ed_unsafe_set_gate(bool on) {
  if (mode != ED_OK) {
    return;
  }

  gpio_put(PIN_ED_GATE, on);
}

uint16_t ed_single_pulse(uint16_t pulse_us, uint16_t max_wait_us) {
  if (mode != ED_OK) {
    return UINT16_MAX;
  }

  gpio_put(PIN_ED_GATE, true);  // discharge ON

  // wait for iginition, with timeout
  absolute_time_t t0 = get_absolute_time();
  uint16_t delay;
  while (true) {
    absolute_time_t t1 = get_absolute_time();
    uint16_t elapsed_us = absolute_time_diff_us(t0, t1);

    bool detected = gpio_get(PIN_ED_DETECT);
    if (detected) {
      delay = elapsed_us;
      break;
    }

    if (elapsed_us >= max_wait_us) {
      // pulse didn't happen within timeout. Turn off and return.
      gpio_put(PIN_ED_GATE, false);  // discharge OFF
      return UINT16_MAX;
    }
  }

  // Pulse started. Wait for pulse duration.
  sleep_us(pulse_us);
  gpio_put(PIN_ED_GATE, false);  // discharge OFF

  return delay;
}

void ed_set_energize(bool on) {
  if (mode != ED_OK) {
    return;
  }

  // TODO: do something
}

bool ed_unsafe_get_detect() {
  if (mode != ED_OK) {
    return false;
  }
  return gpio_get(PIN_ED_DETECT);
}
