// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * To get reliable GATE/DETECT handling, we use dual core.
 * Pin control responsibility is cleanly separated.
 *
 * Once Core0 finishes initialization and passed self-check,
 * Core1 is launched and Core0 relinquishes control over these pins.
 *
 * Core0: slow, complex (IRQ, float-compute allowed)
 * - PIN_I2C_SDA, PIN_I2C_SCL
 * - PIN_TS_I2C_SDA, PIN_TS_I2C_SCL
 * - PIN_LED_STATUS
 *
 * Core1: fast, simple (no IRQ)
 * - PIN_GATE
 * - PIN_GATE_IG, PIN_GATE_MAIN_PWM
 * - PIN_CURR_DETECT
 * - PIN_MUX_V0H, PIN_MUX_V0L, PIN_MUX_VCH, PIN_MUX_VCL, PIN_MUX_V1H,
 * PIN_MUX_V1L
 *
 * Core0 and Core1 share global error_mode flag. Both core can raise error.
 * Core0 write to a critical section csec_pulse, and Core1 read it.
 * No Core1->Core0 data flow (other than global error).
 */
#include "config.h"
#include "hardware/adc.h"
#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "hardware/pwm.h"
#include "pico/i2c_slave.h"
#include "pico/multicore.h"
#include "pico/sync.h"
#include <inttypes.h>
#include <math.h>
#include <stdatomic.h>

// core0, core1 shared
static _Atomic bool error_mode =
    false; // reading & writing true is allowed. never write false.

// core0, core1 shared, only accessed in csec_pulse section or initialization.
static critical_section_t csec_pulse;
static volatile uint8_t csec_pulse_pol;
static volatile uint8_t csec_pulse_pcurr;
static volatile int csec_pulse_pdur;
static volatile uint8_t csec_pulse_max_duty;
static volatile bool csec_pulse_test_disable_short;
static volatile bool csec_pulse_test_disable_ig_wait;

// core0, core1 shared, only accessed in csec_stat section.
static critical_section_t csec_stat;
static uint32_t csec_stat_n_pulse = 0;
static uint32_t csec_stat_n_sample = 0;
static uint64_t csec_stat_accum_igt_us = 0;
static uint64_t csec_stat_accum_igt_sq_us = 0;
static uint32_t csec_stat_dur = 0;
static uint32_t csec_stat_dur_pulse = 0;
static uint32_t csec_stat_dur_short = 0;
static uint32_t csec_stat_dur_open = 0;

////////////////////////////////////////////////////////////////////////////////
// Core1: Gate & current threshold PWM driving and computation.

static const uint8_t PCURR_ON_RESET = 10;    // 1A
static const int PDUR_ON_RESET = 500;        // 500us
static const uint8_t MAX_DUTY_ON_RESET = 25; // 25%

static const uint16_t PWM_GATE_NUM_CYCLE = 300; // create 500kHz (=150MHz/300)

// Maximum duty ratio (to support 25V gap)
static const float PWM_MAX_DUTY = 0.7;

// Maximum allowed current ripple assuming (low-ish) 15V gap voltage & largest
// duty. If (current measurement) > (target current) + MAX_CURR_OVERSHOOT_MA, it
// means the gap is probably in short-mode or some unexpected thing is
// happening. Even in normal situation, output current will fluctuate between
// (target current) -/+ MAX_CURR_OVERSHOOT_MA. (36V - 15V) / 10uH * 2us * 70%
// (PWM_MAX_DUTY) = 2.94A
// 2.94A x 1.2 (to prevent premature shutdown)
static const float MAX_CURR_OVERSHOOT_A = 3.58;

void init_out_pwm() {
  gpio_set_function(PIN_GATE_MAIN_PWM, GPIO_FUNC_PWM);
  pwm_set_wrap(PWM_GATE_MAIN_PWM, PWM_GATE_NUM_CYCLE - 1);
  pwm_set_chan_level(PWM_GATE_MAIN_PWM, PWM_CHAN_GATE_MAIN_PWM, 0);
  pwm_set_enabled(PWM_GATE_MAIN_PWM, true);
}

// Sets current output duty factor.
void set_out_level(float duty) {
  int level = roundf(duty * PWM_GATE_NUM_CYCLE);
  if (level < 0) {
    level = 0;
  } else if (level > PWM_GATE_NUM_CYCLE) {
    level = PWM_GATE_NUM_CYCLE;
  }
  pwm_set_chan_level(PWM_GATE_MAIN_PWM, PWM_CHAN_GATE_MAIN_PWM, level);
}

void turnoff_out() {
  set_out_level(0);
  gpio_put(PIN_GATE_IG, false);
}

////////////////////////////////////////////////////////////////////////////////
// Core1: Current detection ADC.

volatile float latest_curr_a = 0;

void init_curr_detect() {
  adc_init();
  adc_gpio_init(PIN_CURR_DETECT);
  adc_select_input(ADC_CURR_DETECT);

  // Change to PWM mode to reduce power ripple.
  gpio_init(PIN_POWER_PS);
  gpio_set_dir(PIN_POWER_PS, true);
  gpio_put(PIN_POWER_PS, true);

  // wait for power to stabilize
  sleep_ms(10);

  // start sampling
  hw_set_bits(&adc_hw->cs, ADC_CS_START_ONCE_BITS);
}

// This can only measure up to max 22.5A, and with 5.5mA resolution.
// Also, actual updates will happen at about 500kHz.
float get_latest_current_a() {
  if (adc_hw->cs & ADC_CS_READY_BITS) {
    // 12bit, 3.0V max, 133mV/A.
    // 1 LSB = 0.732mV
    // max measurement: 18.79A

    uint16_t val = (uint16_t)adc_hw->result;
    float voltage_mv = (float)val * 0.732;
    latest_curr_a = (voltage_mv - 500) * (1.0 / 133);

    // start next sampling
    hw_set_bits(&adc_hw->cs, ADC_CS_START_ONCE_BITS);
  }
  return latest_curr_a;
}

////////////////////////////////////////////////////////////////////////////////
// Core0: Temperature sensor

static const int TEMP_INVALID = -1000;
static int current_temp_c = TEMP_INVALID;

// Update current_temp by doing ADC read.
// Returns true if ok, false otherwise.
bool update_temp_blocking() {
  uint8_t data = 0;
  if (i2c_write_timeout_us(TS_I2C, TS_I2C_DEV_ADDR, &data, 1, true,
                           TS_I2C_TIMEOUT_US) != 1) {
    return false;
  }
  if (i2c_read_timeout_us(TS_I2C, TS_I2C_DEV_ADDR, &data, 1, false,
                          TS_I2C_TIMEOUT_US) != 1) {
    return false;
  }

  current_temp_c = (int8_t)data;
  return true;
}

// returns: true if ok, false if bad.
bool init_temp_sensor_and_check_sanity() {
  gpio_set_function(PIN_TS_I2C_SCL, GPIO_FUNC_I2C);
  gpio_set_function(PIN_TS_I2C_SDA, GPIO_FUNC_I2C);
  i2c_init(TS_I2C, I2C_BAUD);

  if (!update_temp_blocking()) {
    return false;
  }
  if (current_temp_c == TEMP_INVALID || current_temp_c > MAX_ALLOWED_TEMP) {
    return false;
  }
  return true;
}

////////////////////////////////////////////////////////////////////////////////
// Core0: Register read/write & I2C

static const uint8_t REG_POLARITY = 0x01;
static const uint8_t REG_PULSE_CURRENT = 0x02;
static const uint8_t REG_TEMPERATURE = 0x03;
static const uint8_t REG_PULSE_DUR = 0x04;
static const uint8_t REG_MAX_DUTY = 0x05;
static const uint8_t REG_CKP_N_PULSE = 0x10;
static const uint8_t REG_T_IGNITION = 0x11;
static const uint8_t REG_T_IGNITION_SD = 0x12;
static const uint8_t REG_R_PULSE = 0x13;
static const uint8_t REG_R_SHORT = 0x14;
static const uint8_t REG_R_OPEN = 0x15;
static const uint8_t REG_TEST = 0x80;

static const uint8_t POL_OFF = 0;
static const uint8_t POL_TPWN = 1; // Tool+, Work-
static const uint8_t POL_TNWP = 2; // Tool-, Work+
static const uint8_t POL_TPGN = 3; // Tool+, Grinder-
static const uint8_t POL_TNGP = 4; // Tool-, Grinder+

static const uint8_t TEST_DISABLE_SHORT = 1 << 0;
static const uint8_t TEST_DISABLE_IG_WAIT = 1 << 1;

static bool i2c_ptr_written = false;
static uint8_t i2c_reg_ptr = 0;

static uint8_t visible_n_pulse = 0;
static uint8_t visible_igt_5us = 0;
static uint8_t visible_igt_sd_5us = 0;
static uint8_t visible_r_pulse = 0;
static uint8_t visible_r_short = 0;
static uint8_t visible_r_open = 0;

// write to register. ignores invalid reg address.
void write_reg(uint8_t reg, uint8_t val) {
  switch (reg) {
  case REG_POLARITY:
    if (val != POL_OFF && val != POL_TPWN && val != POL_TNWP &&
        val != POL_TPGN && val != POL_TNGP) {
      val = POL_OFF; // treat unknown value as OFF for safety.
    }
    critical_section_enter_blocking(&csec_pulse);
    csec_pulse_pol = val;
    critical_section_exit(&csec_pulse);
    break;
  case REG_PULSE_CURRENT:
    // Truncate to valid range.
    if (val < 1) {
      val = 1;
    } else if (val > 200) {
      val = 200;
    }
    critical_section_enter_blocking(&csec_pulse);
    csec_pulse_pcurr = val;
    critical_section_exit(&csec_pulse);
    break;
  case REG_PULSE_DUR:
    // Truncate to valid range.
    if (val < 5) {
      val = 5;
    } else if (val > 100) {
      val = 100;
    }
    critical_section_enter_blocking(&csec_pulse);
    csec_pulse_pdur = val * 10; // convert to us
    critical_section_exit(&csec_pulse);
    break;
  case REG_MAX_DUTY:
    // Truncate to valid range.
    if (val < 1) {
      val = 1;
    } else if (val > 95) {
      val = 95;
    }
    critical_section_enter_blocking(&csec_pulse);
    csec_pulse_max_duty = val;
    critical_section_exit(&csec_pulse);
    break;
  case REG_TEST:
    critical_section_enter_blocking(&csec_pulse);
    csec_pulse_test_disable_short = val & TEST_DISABLE_SHORT;
    csec_pulse_test_disable_ig_wait = val & TEST_DISABLE_IG_WAIT;
    critical_section_exit(&csec_pulse);
    break;
  }
}

// read register. return0 for invalid reg address.
uint8_t read_reg(uint8_t reg) {
  switch (reg) {
  case REG_POLARITY: {
    critical_section_enter_blocking(&csec_pulse);
    uint8_t val = csec_pulse_pol;
    critical_section_exit(&csec_pulse);
    return val;
  }
  case REG_PULSE_CURRENT: {
    critical_section_enter_blocking(&csec_pulse);
    uint8_t val = csec_pulse_pcurr;
    critical_section_exit(&csec_pulse);
    return val;
  }
  case REG_TEMPERATURE:
    if (current_temp_c == TEMP_INVALID) {
      return 255;
    } else if (current_temp_c < 0) {
      return 0;
    } else if (current_temp_c >= 254) {
      return 254;
    } else {
      return current_temp_c;
    }
  case REG_PULSE_DUR: {
    critical_section_enter_blocking(&csec_pulse);
    uint8_t val = csec_pulse_pdur / 10; // convert from us to 10us unit
    critical_section_exit(&csec_pulse);
    return val;
  }
  case REG_MAX_DUTY: {
    critical_section_enter_blocking(&csec_pulse);
    uint8_t val = csec_pulse_max_duty;
    critical_section_exit(&csec_pulse);
    return val;
  }
  case REG_CKP_N_PULSE: {
    // Move content to visible buffer and reset internal buffer.
    // Copy to temp vars to leave critical section ASAP to avoid distrupting
    // core1.
    critical_section_enter_blocking(&csec_stat);
    uint32_t stat_n_pulse = csec_stat_n_pulse;
    uint32_t stat_n_sample = csec_stat_n_sample;
    uint64_t stat_accum_igt_us = csec_stat_accum_igt_us;
    uint64_t stat_accum_igt_sq_us = csec_stat_accum_igt_sq_us;
    uint32_t stat_dur = csec_stat_dur;
    uint32_t stat_dur_pulse = csec_stat_dur_pulse;
    uint32_t stat_dur_short = csec_stat_dur_short;
    uint32_t stat_dur_open = csec_stat_dur_open;
    // reset
    csec_stat_n_pulse = 0;
    csec_stat_n_sample = 0;
    csec_stat_accum_igt_us = 0;
    csec_stat_accum_igt_sq_us = 0;
    csec_stat_dur = 0;
    csec_stat_dur_pulse = 0;
    csec_stat_dur_short = 0;
    csec_stat_dur_open = 0;
    critical_section_exit(&csec_stat);

    // convert
    visible_n_pulse = stat_n_pulse > 255 ? 255 : stat_n_pulse;
    if (stat_n_sample == 0) {
      visible_igt_5us = 255;    // invalid
      visible_igt_sd_5us = 255; // invalid
    } else {
      uint16_t igt_avg = stat_accum_igt_us / stat_n_sample;
      // Quantization error might cause negative value, so use signed and clamp.
      int32_t igt_var = (int32_t)(stat_accum_igt_sq_us / stat_n_sample) -
                        (int32_t)(igt_avg * igt_avg);
      if (igt_var < 0) {
        igt_var = 0;
      }
      uint16_t igt_sd = sqrtf(igt_var);
      visible_igt_5us = igt_avg / 5;
      visible_igt_sd_5us = igt_sd / 5;
    }
    visible_r_pulse = (uint64_t)stat_dur_pulse * 255 / stat_dur;
    visible_r_short = (uint64_t)stat_dur_short * 255 / stat_dur;
    visible_r_open = (uint64_t)stat_dur_open * 255 / stat_dur;
    return visible_n_pulse;
  }
  case REG_T_IGNITION:
    return visible_igt_5us;
  case REG_T_IGNITION_SD:
    return visible_igt_sd_5us;
  case REG_R_PULSE:
    return visible_r_pulse;
  case REG_R_SHORT:
    return visible_r_short;
  case REG_R_OPEN:
    return visible_r_open;
  case REG_TEST: {
    critical_section_enter_blocking(&csec_pulse);
    uint8_t val = 0;
    if (csec_pulse_test_disable_short) {
      val |= TEST_DISABLE_SHORT;
    }
    if (csec_pulse_test_disable_ig_wait) {
      val |= TEST_DISABLE_IG_WAIT;
    }
    critical_section_exit(&csec_pulse);
    return val;
  }
  }
  return 0;
}

// handle I2C requests.
static void i2c_slave_handler(i2c_inst_t* i2c, i2c_slave_event_t event) {
  switch (event) {
  case I2C_SLAVE_RECEIVE:
    if (!i2c_ptr_written) {
      i2c_reg_ptr = i2c_read_byte_raw(i2c);
      i2c_ptr_written = true;
    } else {
      write_reg(i2c_reg_ptr, i2c_read_byte_raw(i2c));
      i2c_reg_ptr++;
    }
    break;
  case I2C_SLAVE_REQUEST:
    i2c_write_byte_raw(i2c, read_reg(i2c_reg_ptr));
    i2c_reg_ptr++;
    break;
  case I2C_SLAVE_FINISH:
    i2c_ptr_written = false;
    break;
  default:
    break;
  }
}

void init_reg_rw_i2c() {
  gpio_set_function(PIN_I2C_SCL, GPIO_FUNC_I2C);
  gpio_set_function(PIN_I2C_SDA, GPIO_FUNC_I2C);
  i2c_init(HOST_I2C, I2C_BAUD);
  i2c_slave_init(HOST_I2C, I2C_DEV_ADDR, &i2c_slave_handler);
}

////////////////////////////////////////////////////////////////////////////////
// Main loops for each core.

// Treat ignition time of this or smaller as short.
static const uint16_t IG_THRESH_SHORT_US = 5;
// Treat ignition time of this or larger as open.
static const uint16_t IG_THRESH_OPEN_US = 1000;

static const uint16_t COOLDOWN_SHORT_US = 100;

static const uint16_t COOLDOWN_PULSE_MIN_US = 5;

static const uint32_t MASK_ALL_MUX_PINS =
    (1 << PIN_MUX_V0H) | (1 << PIN_MUX_V0L) | (1 << PIN_MUX_VCH) |
    (1 << PIN_MUX_VCL) | (1 << PIN_MUX_V1H) | (1 << PIN_MUX_V1L);

// Get pin value with about ~250ns noise filtering.
// Returns the denoised value, or default_val if the signal is unstable.
static inline bool get_pin_denoise(uint gpio_pin, bool default_val) {
  bool val = gpio_get(gpio_pin);
  for (uint8_t i = 0; i < 8; i++) {
    // each cycle is about 10 cycle
    bool val_verify = gpio_get(gpio_pin);
    if (val_verify != val) {
      return default_val;
    }
  }
  return val;
}

static inline float clampf(float val, float min, float max) {
  if (val < min) {
    return min;
  } else if (val > max) {
    return max;
  } else {
    return val;
  }
}

void core1_main() {
  uint8_t curr_pol = POL_OFF;
  float curr_pcurr = 1;

  // Each loop is expected to finish well within 1us.
  // But when applying changes to pol/pcurr, it can take as long as it needs.
  while (true) {
    // Exit if global error mode is set.
    if (atomic_load(&error_mode)) {
      goto fatal_error;
    }

    // Fetch latest pulse config for processing.
    critical_section_enter_blocking(&csec_pulse);
    uint8_t new_pol = csec_pulse_pol;
    uint8_t new_pcurr = csec_pulse_pcurr;
    uint16_t pdur = csec_pulse_pdur;
    uint8_t max_duty = csec_pulse_max_duty;
    bool test_disable_short = csec_pulse_test_disable_short;
    bool test_disable_ig_wait = csec_pulse_test_disable_ig_wait;
    critical_section_exit(&csec_pulse);
    uint16_t pinterval = (uint32_t)pdur * 100 / (uint32_t)max_duty;

    // Apply POL change.
    if (curr_pol != new_pol) {
      // LONG PROCESS
      sleep_us(DISCHARGE_MAX_SETTLE_TIME_US);

      gpio_put_masked(MASK_ALL_MUX_PINS, 0);
      sleep_us(MUX_MAX_SETTLE_TIME_US);

      if (new_pol == POL_OFF) {
        gpio_put_masked(MASK_ALL_MUX_PINS,
                        1 << PIN_MUX_V0L | 1 << PIN_MUX_VCL | 1 << PIN_MUX_V1L);
      } else if (new_pol == POL_TPWN || new_pol == POL_TPGN) {
        // T+, others-
        gpio_put_masked(MASK_ALL_MUX_PINS,
                        1 << PIN_MUX_V0L | 1 << PIN_MUX_V1L | 1 << PIN_MUX_VCH);
      } else {
        // T-, others+
        gpio_put_masked(MASK_ALL_MUX_PINS,
                        1 << PIN_MUX_V0H | 1 << PIN_MUX_V1H | 1 << PIN_MUX_VCL);
      }
      sleep_us(MUX_MAX_SETTLE_TIME_US);
      curr_pol = new_pol;
    }

    // Apply current change.
    curr_pcurr = new_pcurr;

    bool gate = get_pin_denoise(PIN_GATE, false);
    if (!gate) {
      continue;
    }

    /////
    //  Emit single pulse if gate is HIGH.

    // turn on and wait for discharge to happen.
    gpio_put(PIN_GATE_IG, true);
    uint16_t igt_us = 0;
    while (true && !test_disable_ig_wait) {
      if (!get_pin_denoise(PIN_GATE, true)) {
        turnoff_out();
        goto pulse_ended;
      }
      if (get_latest_current_a() >= 0.5) {
        // discharge started.
        break;
      }
      sleep_us(1);
      critical_section_enter_blocking(&csec_stat);
      csec_stat_dur++;
      csec_stat_dur_open++;
      critical_section_exit(&csec_stat);

      igt_us++;
      if (igt_us > IG_THRESH_OPEN_US) {
        igt_us = IG_THRESH_OPEN_US;
      }
    }

    if (igt_us < IG_THRESH_SHORT_US && !test_disable_short) {
      // short; turn-off and short-cooldown.
      turnoff_out();
      sleep_us(COOLDOWN_SHORT_US);
      critical_section_enter_blocking(&csec_stat);
      csec_stat_dur += COOLDOWN_SHORT_US;
      csec_stat_dur_short += COOLDOWN_SHORT_US;
      critical_section_exit(&csec_stat);
    } else {
      // normal pulse; update stats & wait for pulse duration.
      critical_section_enter_blocking(&csec_stat);
      csec_stat_n_pulse++;
      if (igt_us < IG_THRESH_OPEN_US) {
        csec_stat_n_sample++;
        csec_stat_accum_igt_us += igt_us;
        csec_stat_accum_igt_sq_us += igt_us * igt_us;
      }
      critical_section_exit(&csec_stat);

      // control current for pdur.
      absolute_time_t t_ig_start = get_absolute_time();
      int gate_off_consecutive = 0;
      float duty = 0;
      const float gain = 0.02;
      for (uint16_t i = 0; i < pdur; i++) {
        // Monitor gate with denoising.
        if (!gpio_get(PIN_GATE)) {
          gate_off_consecutive++;
        }
        if (gate_off_consecutive > 10) {
          turnoff_out();
          goto pulse_ended;
        }

        // Turn off ignition voltage and hand over to PWM current.
        // Empirically, 3us is enough for discharge to stabilize to 20V.
        if (i >= 3) {
          gpio_put(PIN_GATE_IG, false);
        }

        // Control constant-current PWM.
        float curr_a = get_latest_current_a();
        if (curr_a > curr_pcurr + MAX_CURR_OVERSHOOT_A) {
          // current is too high for a normal gap.
          // gap might get shorted during the pulse,
          // or control is oscillating.
          // NOTE: maybe this should be counted and should be exposed via
          // register?
          break;
        }
        duty += (curr_pcurr - curr_a) * gain;
        duty = clampf(duty, 0, PWM_MAX_DUTY);
        set_out_level(duty);

        // Record 1us past as pulse time.
        critical_section_enter_blocking(&csec_stat);
        csec_stat_dur++;
        csec_stat_dur_pulse++;
        critical_section_exit(&csec_stat);

        // Absorb processing time variation.
        sleep_until(delayed_by_us(t_ig_start, i + 1));
      }

      // turn-off and cooldown.
      turnoff_out();
      int32_t cooldown_time = pinterval - (int32_t)(igt_us + pdur);
      if (cooldown_time < COOLDOWN_PULSE_MIN_US) {
        cooldown_time = COOLDOWN_PULSE_MIN_US;
      }
      sleep_us(cooldown_time);
      critical_section_enter_blocking(&csec_stat);
      csec_stat_dur += cooldown_time;
      critical_section_exit(&csec_stat);
    }
  pulse_ended:
  }

fatal_error:
  atomic_store(&error_mode, true); // tell other core

  // De-energize safely.
  set_out_level(0);
  sleep_us(DISCHARGE_MAX_SETTLE_TIME_US);
  gpio_put_masked(MASK_ALL_MUX_PINS, 0);
  sleep_ms(MUX_MAX_SETTLE_TIME_US);

  while (true) {
  }
}

// core0
int main() {
  // Init compute.
  csec_pulse_pol = POL_OFF;
  csec_pulse_pcurr = PCURR_ON_RESET;
  csec_pulse_pdur = PDUR_ON_RESET;
  csec_pulse_max_duty = MAX_DUTY_ON_RESET;
  csec_pulse_test_disable_short = false;
  critical_section_init(&csec_pulse);
  critical_section_init(&csec_stat);

  // Init I/O to safe state.
  const uint32_t output_mask = (1 << PIN_LED_STATUS) | (1 << PIN_I2C_SDA) |
                               (1 << PIN_I2C_SCL) | (1 << PIN_TS_I2C_SDA) |
                               (1 << PIN_TS_I2C_SCL) | (1 << PIN_GATE_IG) |
                               (1 << PIN_GATE_MAIN_PWM) | MASK_ALL_MUX_PINS;

  const uint32_t input_mask = (1 << PIN_GATE);

  gpio_init_mask(output_mask | input_mask);
  gpio_set_dir_masked(output_mask | input_mask, output_mask);
  gpio_clr_mask(output_mask);
  gpio_pull_down(PIN_GATE); // for safety when host is unavailable

  ////////////////////////////////////////////////////////////
  // Initialize "modules" with sanity checks, starting from safe ones.

  if (gpio_get(PIN_GATE)) {
    // Sanity check; master must not be driving GATE high when turning on ED.
    goto fatal_error;
  }
  if (!init_temp_sensor_and_check_sanity()) {
    goto fatal_error;
  }

  init_curr_detect();
  init_out_pwm();
  init_reg_rw_i2c();
  multicore_launch_core1(core1_main);

  ////////////////////////////////////////////////////////////
  // device is now operating normally.
  gpio_put(PIN_LED_STATUS, 1);

  // main loop
  while (true) {
    if (atomic_load(&error_mode)) {
      goto fatal_error;
    }

    update_temp_blocking();
    if (current_temp_c == TEMP_INVALID || current_temp_c > MAX_ALLOWED_TEMP) {
      goto fatal_error;
    }
  }

fatal_error:
  atomic_store(&error_mode, true); // tell other core

  while (true) {
    // "error blink" forever
    gpio_put(PIN_LED_STATUS, 1);
    sleep_ms(LED_ERR_BLINK_ON_MS);
    gpio_put(PIN_LED_STATUS, 0);
    sleep_ms(LED_ERR_BLINK_OFF_MS);
  }
}
