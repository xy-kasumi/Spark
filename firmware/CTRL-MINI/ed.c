#include "ed.h"

#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "pico/stdlib.h"
#include "pico/time.h"

#include "config.h"

static const uint8_t REG_POLARITY = 0x01;
static const uint8_t REG_PULSE_CURRENT = 0x02;
static const uint8_t REG_TEMPERATURE = 0x03;

static const uint8_t POLARITY_OFF = 0;
static const uint8_t POLARITY_TPWN = 1;  // Tool+, Work-
static const uint8_t POLARITY_TNWP = 2;  // Tool-, Work+
static const uint8_t POLARITY_TPGN = 3;  // Tool+, Grinder-
static const uint8_t POLARITY_TNGP = 4;  // Tool-, Grinder+

static const uint8_t TEMP_INVALID_VALUE = 255;

static const uint16_t WAIT_PULSE_CURRENT_US = 1000;
static const uint16_t WAIT_POLARITY_US = 20000;


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

// Read single byte from the specified register, with reasonable timeout.
// Returns true if successful, false if timeout or error.
bool read_reg(uint8_t reg_addr, uint8_t* val) {
  if (i2c_write_timeout_us(ED_I2C, ED_I2C_ADDR, &reg_addr, 1, true, ED_I2C_MAX_TX_US) != 1) {
    return false;
  }
  if (i2c_read_timeout_us(ED_I2C, ED_I2C_ADDR, val, 1, false, ED_I2C_MAX_TX_US) != 1) {
    return false;
  }
  return true;
}

// Write single byte to the specified register, with reasonable timeout.
// Returns true if successful, false if timeout or error.
bool write_reg(uint8_t reg_addr, uint8_t val) {
  uint8_t buffer[2] = {reg_addr, val};
  return i2c_write_timeout_us(ED_I2C, ED_I2C_ADDR, buffer, 2, false, ED_I2C_MAX_TX_US) == 2;
}

void ed_init() {
  gpio_init_mask((1 << PIN_ED_GATE) | (1 << PIN_ED_DETECT) | (1 << PIN_ED_I2C_SCL) | (1 << PIN_ED_I2C_SDA));
  gpio_set_dir(PIN_ED_DETECT, GPIO_IN);
  gpio_pull_down(PIN_ED_DETECT);

  // Init I2C.
  i2c_init(ED_I2C, ED_I2C_BAUD);
  gpio_set_function(PIN_ED_I2C_SDA, GPIO_FUNC_I2C);
  gpio_set_function(PIN_ED_I2C_SCL, GPIO_FUNC_I2C);

  // Check temperature sanity.
  uint8_t temp;
  if (read_reg(REG_TEMPERATURE, &temp)) {
    if (temp == TEMP_INVALID_VALUE) {
      return; // temp sensor not working
    }
    if (temp > 80) {
      return; // too hot for start condition
    }
    mode = ED_OK;
  }
}

bool ed_available() {
  return mode == ED_OK;
}

uint8_t ed_temp() {
  if (mode != ED_OK) {
    return 255;
  }
  uint8_t temp;
  if (!read_reg(REG_TEMPERATURE, &temp)) {
    return 255;
  }
  return temp;
}

void ed_set_current(uint16_t current_ma) {
  if (mode != ED_OK) {
    return;
  }
  write_reg(REG_PULSE_CURRENT, current_ma / 100);
  sleep_us(WAIT_PULSE_CURRENT_US);
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

  write_reg(REG_POLARITY, POLARITY_TNWP);
  sleep_us(WAIT_POLARITY_US);
}

bool ed_unsafe_get_detect() {
  if (mode != ED_OK) {
    return false;
  }
  return gpio_get(PIN_ED_DETECT);
}
