// SPDX-License-Identifier: AGPL-3.0-or-later
#include "pulser.h"

#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "pico/stdlib.h"
#include "pico/time.h"
#include <stdio.h>

#include "config.h"

static const uint8_t REG_POLARITY = 0x01;
static const uint8_t REG_PULSE_CURRENT = 0x02;
static const uint8_t REG_TEMPERATURE = 0x03;
static const uint8_t REG_PULSE_DUR = 0x04;
static const uint8_t REG_MAX_DUTY = 0x05;
static const uint8_t REG_CKP_N_PULSE = 0x10;
static const uint8_t REG_T_IGNITION = 0x11;
static const uint8_t REG_R_PULSE = 0x12;
static const uint8_t REG_R_SHORT = 0x13;
static const uint8_t REG_R_OPEN = 0x14;

static const uint8_t POLARITY_OFF = 0;
static const uint8_t POLARITY_TPWN = 1; // Tool+, Work-
static const uint8_t POLARITY_TNWP = 2; // Tool-, Work+
static const uint8_t POLARITY_TPGN = 3; // Tool+, Grinder-
static const uint8_t POLARITY_TNGP = 4; // Tool-, Grinder+

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
  PULSER_UNKNOWN,
  PULSER_OK, // I2C comm success
} pulser_mode_t;

static pulser_mode_t mode = PULSER_UNKNOWN;

static int cnt_i2c_read_error = 0;
static int cnt_i2c_write_error = 0;

// Read single byte from the specified register, with reasonable timeout.
// Returns true if successful, false if timeout or error.
bool read_reg(uint8_t reg_addr, uint8_t* val) {
  if (i2c_write_timeout_us(PULSER_I2C, PULSER_I2C_ADDR, &reg_addr, 1, true,
                           PULSER_I2C_MAX_TX_US) != 1) {
    cnt_i2c_read_error++;
    return false;
  }
  if (i2c_read_timeout_us(PULSER_I2C, PULSER_I2C_ADDR, val, 1, false,
                          PULSER_I2C_MAX_TX_US) != 1) {
    cnt_i2c_read_error++;
    return false;
  }
  return true;
}

// Read multiple consequtive bytes from the specified register, with reasonable
// timeout. Returns true if successful, false if timeout or error.
bool read_regs(uint8_t reg_addr, uint8_t* ptr, size_t size) {
  if (i2c_write_timeout_us(PULSER_I2C, PULSER_I2C_ADDR, &reg_addr, 1, true,
                           PULSER_I2C_MAX_TX_US) != 1) {
    cnt_i2c_read_error++;
    return false;
  }
  if (i2c_read_timeout_us(PULSER_I2C, PULSER_I2C_ADDR, ptr, size, false,
                          PULSER_I2C_MAX_TX_US) != size) {
    cnt_i2c_read_error++;
    return false;
  }
  return true;
}

// Write single byte to the specified register, with reasonable timeout.
// Returns true if successful, false if timeout or error.
bool write_reg(uint8_t reg_addr, uint8_t val) {
  uint8_t buffer[2] = {reg_addr, val};
  if (i2c_write_timeout_us(PULSER_I2C, PULSER_I2C_ADDR, buffer, 2, false,
                           PULSER_I2C_MAX_TX_US) != 2) {
    cnt_i2c_write_error++;
    return false;
  }
  return true;
}

void pulser_init() {
  gpio_init_mask((1 << PIN_PULSER_GATE) | (1 << PIN_PULSER_I2C_SCL) |
                 (1 << PIN_PULSER_I2C_SDA));
  gpio_set_dir(PIN_PULSER_GATE, GPIO_OUT);

  // Init I2C.
  i2c_init(PULSER_I2C, PULSER_I2C_BAUD);
  gpio_set_function(PIN_PULSER_I2C_SDA, GPIO_FUNC_I2C);
  gpio_set_function(PIN_PULSER_I2C_SCL, GPIO_FUNC_I2C);

  // Poll ED board until 1000ms (typ PSU turn on time x2).
  for (int i = 0; i < 10; i++) {
    // Check temperature sanity.
    uint8_t temp;
    if (read_reg(REG_TEMPERATURE, &temp)) {
      if (temp == TEMP_INVALID_VALUE) {
        return; // temp sensor not working
      }
      if (temp > 80) {
        return; // too hot for start condition
      }
      mode = PULSER_OK;
      return;
    }

    sleep_ms(100);
  }
}

bool pulser_available() { return mode == PULSER_OK; }

int pulser_temp() {
  if (mode != PULSER_OK) {
    return 255;
  }
  uint8_t temp;
  if (!read_reg(REG_TEMPERATURE, &temp)) {
    return 255;
  }
  return temp;
}

void pulser_dump_state(char* ptr, size_t size) {
  const char* mode_str = mode == PULSER_OK ? "OK" : "NG";
  int temp = pulser_temp();
  snprintf(ptr, size, "%s, temp=%u C (i2c-r-err: %u, i2c-w-err: %u)", mode_str,
           temp, cnt_i2c_read_error, cnt_i2c_write_error);
}

void pulser_set_current(int current_ma) {
  if (mode != PULSER_OK) {
    return;
  }
  write_reg(REG_PULSE_CURRENT, current_ma / 100);
  sleep_us(WAIT_PULSE_CURRENT_US);
}

void pulser_set_max_duty(int duty_pct) {
  if (duty_pct < 1) {
    duty_pct = 1;
  } else if (duty_pct > 95) {
    duty_pct = 95;
  }

  write_reg(REG_MAX_DUTY, duty_pct);
}

void pulser_set_pulse_dur(int pulse_dur_us) {
  if (pulse_dur_us < 50) {
    pulse_dur_us = 50;
  } else if (pulse_dur_us > 1000) {
    pulse_dur_us = 1000;
  }
  write_reg(REG_PULSE_DUR, pulse_dur_us / 10);
}

void pulser_unsafe_set_gate(bool on) {
  if (mode != PULSER_OK) {
    return;
  }
  gpio_put(PIN_PULSER_GATE, on);
}

void pulser_set_energize(bool on) {
  if (mode != PULSER_OK) {
    return;
  }

  write_reg(REG_POLARITY, on ? POLARITY_TNWP : POLARITY_OFF);
  sleep_us(WAIT_POLARITY_US);
}

bool pulser_unsafe_get_detect() {
  if (mode != PULSER_OK) {
    return false;
  }
  return false; // gpio_get(PIN_PULSER_DETECT);
}

void pulser_checkpoint_read(int* n_pulse, int* avg_igt_us, int* sd_igt_us,
                            int* r_pulse, int* r_short, int* r_open) {
  uint8_t buffer[6];
  if (read_regs(REG_CKP_N_PULSE, buffer, sizeof(buffer))) {
    *n_pulse = 0;
    *avg_igt_us = 0;
    *sd_igt_us = 0;
    *r_pulse = 0;
    *r_short = 0;
    *r_open = 255;
    return;
  }
  *n_pulse = buffer[0];
  *avg_igt_us = buffer[1] * 5;
  *sd_igt_us = buffer[2] * 5;
  *r_pulse = buffer[3];
  *r_short = buffer[4];
  *r_open = buffer[5];
}

uint8_t pulser_read_register(uint8_t reg_addr) {
  // omit mode check for easier debugging
  uint8_t val;
  if (!read_reg(reg_addr, &val)) {
    return 0;
  }
  return val;
}

void pulser_write_register(uint8_t reg_addr, uint8_t data) {
  if (mode != PULSER_OK) {
    return;
  }
  write_reg(reg_addr, data);
}
