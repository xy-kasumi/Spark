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
 * - PIN_LED_STATUS
 * - PIN_TEMP_HS
 *
 * Core1: fast, simple (no IRQ)
 * - PIN_GATE, PIN_CURR_TRIGGER
 * - PIN_CURR_GATE_PWM
 * - PIN_LED_POWER
 * - PIN_CURR_THRESH_PWM
 * - PIN_MUX_EN, PIN_MUX_POL, PIN_MUX_WG
 *
 * Core0 and Core1 share global error_mode flag. Both core can raise error.
 * Core0 write to a critical section csec_pulse, and Core1 read it.
 * No Core1->Core0 data flow (other than global error).
 */
#include "hardware/adc.h"
#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "hardware/pwm.h"
#include "pico/i2c_slave.h"
#include "pico/multicore.h"
#include "pico/sync.h"
#include <inttypes.h>
#include <stdatomic.h>
#include <math.h>
#include "config.h"

// core0, core1 shared
static _Atomic bool error_mode =
    false; // reading & writing true is allowed. never write false.

// core0, core1 shared, only accessed in csec_pulse section or initialization.
static critical_section_t csec_pulse;
static uint8_t csec_pulse_pol;
static uint8_t csec_pulse_pcurr;
static uint16_t csec_pulse_pdur;
static uint8_t csec_pulse_max_duty;
static uint8_t csec_pulse_th_on_cyc;

// core0, core1 shared, only accessed in csec_stat section.
static critical_section_t csec_stat;
static uint32_t csec_stat_n_pulse = 0;
static uint64_t csec_stat_accum_igt_us = 0;
static uint64_t csec_stat_accum_igt_sq_us = 0;
static uint32_t csec_stat_dur = 0;
static uint32_t csec_stat_dur_pulse = 0;
static uint32_t csec_stat_dur_short = 0;
static uint32_t csec_stat_dur_open = 0;

////////////////////////////////////////////////////////////////////////////////
// Core1: Gate & current threshold PWM driving and computation.

static const uint8_t PCURR_ON_RESET = 10; // 1A
static const uint16_t PDUR_ON_RESET = 500; // 500us
static const uint8_t MAX_DUTY_ON_RESET = 25; // 25%

static const uint8_t PWM_GATE_NUM_CYCLE = 89;
static const uint8_t PWM_THRESH_NUM_CYCLE = 150;

void init_out_pwm() {
  gpio_set_function(PIN_CURR_GATE_PWM, GPIO_FUNC_PWM);
  pwm_set_wrap(PWM_CURR_GATE_PWM, PWM_GATE_NUM_CYCLE - 1);
  pwm_set_chan_level(PWM_CURR_GATE_PWM, PWM_CHAN_CURR_GATE_PWM, 0);
  pwm_set_enabled(PWM_CURR_GATE_PWM, true);
}

// Sets current output level.
// level: 0~80 (0A~8A, 100mA/level)
void set_out_level(uint8_t level) {
  pwm_set_chan_level(PWM_CURR_GATE_PWM, PWM_CHAN_CURR_GATE_PWM, level);
}

// core0
// cyc: whatever value determined by compute_th_on_cyc(), 0, or
// PWM_THRESH_NUM_CYCLE.
void init_thresh_pwm(uint8_t cyc) {
  gpio_set_function(PIN_CURR_THRESH_PWM, GPIO_FUNC_PWM);
  pwm_set_wrap(PWM_CURR_THRESH_PWM, PWM_THRESH_NUM_CYCLE - 1);
  pwm_set_chan_level(PWM_CURR_THRESH_PWM, PWM_CHAN_CURR_THRESH_PWM, cyc);
  pwm_set_enabled(PWM_CURR_THRESH_PWM, true);
}

// Sets current threshold level.
// cyc: whatever value determined by compute_th_on_cyc(), 0, or
// PWM_THRESH_NUM_CYCLE.
void set_thresh_level(uint8_t cyc) {
  pwm_set_chan_level(PWM_CURR_THRESH_PWM, PWM_CHAN_CURR_THRESH_PWM, cyc);
}

// core0
// Compute final thresh PWM on cycles, that works well for pcurr (1~80;
// 100mA~8A).
uint8_t compute_th_on_cyc(uint8_t pcurr) {
  const float PCURR_TO_FB_VOLT =
      0.1 * 0.22; // *0.1: pcurr value to Ip(A). *0.22: FB resistor 220mOhm.
  const float PCURR_TO_THRESH_VOLT =
      PCURR_TO_FB_VOLT * 0.25; // target 25% threshold.
  const float PCURR_TO_THRESH_ON_CYC =
      PCURR_TO_THRESH_VOLT *
      ((1 / 3.3) * PWM_THRESH_NUM_CYCLE); // /3.3: volt to duty factor.

  float on_cyc = pcurr * PCURR_TO_THRESH_ON_CYC;
  if (on_cyc >= PWM_THRESH_NUM_CYCLE) {
    return PWM_THRESH_NUM_CYCLE;
  } else {
    return (uint8_t)on_cyc;
  }
}

////////////////////////////////////////////////////////////////////////////////
// Core0: Temperature sensor

static const int16_t TEMP_INVALID = -1000;
static int16_t current_temp = TEMP_INVALID;

// Convert raw ADC value to temperature in Celsius.
// Returns TEMP_INVALID if it's suspected the device is broken or in extreme
// condition.
int16_t convert_hs_temp(uint16_t raw_adc_value) {
  // Convert raw 12-bit ADC value (0-4095) to voltage (0-3.3V)
  float voltage = raw_adc_value * 3.3f / 4096.0f;

  // Based on voltage-temp table from spec:
  // 0.29V -> -5°C
  // 0.89V -> 20°C
  // 1.97V -> 50°C
  // 2.65V -> 75°C
  // 3.01V -> 100°C
  // 3.16V -> 125°C
  if (voltage < 0.29f || voltage > 3.16f) {
    return TEMP_INVALID;
  }

  // Linear interpolation between closest points
  if (voltage <= 0.89f) {
    // Between -5°C and 20°C
    return (int16_t)(-5 + (voltage - 0.29f) * (25.0f / 0.6f));
  } else if (voltage <= 1.97f) {
    // Between 20°C and 50°C
    return (int16_t)(20 + (voltage - 0.89f) * (30.0f / 1.08f));
  } else if (voltage <= 2.65f) {
    // Between 50°C and 75°C
    return (int16_t)(50 + (voltage - 1.97f) * (25.0f / 0.68f));
  } else if (voltage <= 3.01f) {
    // Between 75°C and 100°C
    return (int16_t)(75 + (voltage - 2.65f) * (25.0f / 0.36f));
  } else {
    // Between 100°C and 125°C
    return (int16_t)(100 + (voltage - 3.01f) * (25.0f / 0.15f));
  }
}

// Update current_temp by doing ADC read.
void update_temp_blocking() { current_temp = convert_hs_temp(adc_read()); }

// returns: true if ok, false if bad.
bool init_temp_sensor_and_check_sanity() {
  adc_init();
  adc_gpio_init(PIN_TEMP_HS);
  adc_select_input(ADC_TEMP_HS);

  update_temp_blocking();
  return current_temp != TEMP_INVALID && current_temp <= MAX_ALLOWED_TEMP;
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

static const uint8_t POL_OFF = 0;
static const uint8_t POL_TPWN = 1; // Tool+, Work-
static const uint8_t POL_TNWP = 2; // Tool-, Work+
static const uint8_t POL_TPGN = 3; // Tool+, Grinder-
static const uint8_t POL_TNGP = 4; // Tool-, Grinder+

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
    } else if (val > 80) {
      val = 80;
    }
    uint8_t cyc = compute_th_on_cyc(val);
    critical_section_enter_blocking(&csec_pulse);
    csec_pulse_pcurr = val;
    csec_pulse_th_on_cyc = cyc;
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
    if (current_temp == TEMP_INVALID) {
      return 255;
    } else if (current_temp < 0) {
      return 0;
    } else if (current_temp >= 254) {
      return 254;
    } else {
      return current_temp;
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
    uint64_t stat_accum_igt_us = csec_stat_accum_igt_us;
    uint64_t stat_accum_igt_sq_us = csec_stat_accum_igt_sq_us;
    uint32_t stat_dur = csec_stat_dur;
    uint32_t stat_dur_pulse = csec_stat_dur_pulse;
    uint32_t stat_dur_short = csec_stat_dur_short;
    uint32_t stat_dur_open = csec_stat_dur_open;
    // reset
    csec_stat_n_pulse = 0;
    csec_stat_accum_igt_us = 0;
    csec_stat_accum_igt_sq_us = 0;
    csec_stat_dur = 0;
    csec_stat_dur_pulse = 0;
    csec_stat_dur_short = 0;
    csec_stat_dur_open = 0;
    critical_section_exit(&csec_stat);

    // convert
    visible_n_pulse = stat_n_pulse > 255 ? 255 : stat_n_pulse;
    if (stat_n_pulse == 0) {
      visible_igt_5us = 0;
      visible_igt_sd_5us = 0;
    } else {
      uint16_t igt_avg = stat_accum_igt_us / stat_n_pulse;
      // Quantization error might cause negative value, so use signed and clamp.
      int32_t igt_var = (int32_t) (stat_accum_igt_sq_us / stat_n_pulse) - (int32_t) (igt_avg * igt_avg);
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

void core1_main() {
  uint8_t curr_pol = POL_OFF;
  uint8_t curr_pcurr = 1;

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
    uint8_t new_th_on_cyc = csec_pulse_th_on_cyc;
    uint16_t pdur = csec_pulse_pdur;
    uint8_t max_duty = csec_pulse_max_duty;
    critical_section_exit(&csec_pulse);
    uint16_t pinterval = (uint32_t)pdur * 100 / (uint32_t)max_duty;

    // Apply POL change.
    if (curr_pol != new_pol) {
      // LONG PROCESS
      sleep_us(DISCHARGE_MAX_SETTLE_TIME_US);
      if (new_pol == POL_OFF) {
        gpio_put(PIN_MUX_EN, 0);
        sleep_ms(RELAY_MAX_SETTLE_TIME_MS);
        gpio_put(PIN_LED_POWER, 0);
      } else {
        gpio_put(PIN_LED_POWER, true);
        gpio_put(PIN_MUX_EN, true);
        gpio_put(PIN_MUX_WG, new_pol == POL_TPGN || new_pol == POL_TNGP);
        gpio_put(PIN_MUX_POL, new_pol == POL_TPWN || new_pol == POL_TPGN);
        sleep_ms(RELAY_MAX_SETTLE_TIME_MS);
      }
    }
    curr_pol = new_pol;

    // Apply current change.
    if (curr_pcurr != new_pcurr) {
      // LONG PROCESS
      set_thresh_level(new_th_on_cyc);
      sleep_ms(THRESH_MAX_SETTLE_TIME_MS);
    }
    curr_pcurr = new_pcurr;

    // Get noise-filtered gate value.
    bool gate = gpio_get(PIN_GATE);
    for (uint8_t i = 0; i < 15; i++) {
      // each cycle is about 10 cycle
      bool gate_verify = gpio_get(PIN_GATE);
      if (gate_verify != gate) {
        continue; // signal unstable; ignore
      }
    }

    if (!gate) {
      continue;
    }

    /////
    //  Emit single pulse if gate is HIGH.

    // turn on and wait for discharge to happen.
    set_out_level(curr_pcurr);
    uint16_t igt_us = 0;
    while (true) {
      if (!gpio_get(PIN_GATE)) {
        set_out_level(0);
        goto pulse_ended;
      }
      if (gpio_get(PIN_CURR_TRIGGER)) {
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

    if (igt_us < IG_THRESH_SHORT_US) {
      // short; turn-off and short-cooldown.
      set_out_level(0);
      sleep_us(COOLDOWN_SHORT_US);
      critical_section_enter_blocking(&csec_stat);
      csec_stat_dur += COOLDOWN_SHORT_US;
      csec_stat_dur_short += COOLDOWN_SHORT_US;
      critical_section_exit(&csec_stat);
    } else {
      // normal pulse; update stats & wait for pulse duration.
      critical_section_enter_blocking(&csec_stat);
      csec_stat_n_pulse++;
      csec_stat_accum_igt_us += igt_us;
      csec_stat_accum_igt_sq_us += igt_us * igt_us;
      critical_section_exit(&csec_stat);
      for (uint16_t i = 0; i < pdur; i++) {
        if (!gpio_get(PIN_GATE)) {
          set_out_level(0);
          goto pulse_ended;
        }
        sleep_us(1);
        critical_section_enter_blocking(&csec_stat);
        csec_stat_dur++;
        csec_stat_dur_pulse++;
        critical_section_exit(&csec_stat);
      }

      // turn-off and cooldown.
      set_out_level(0);
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
  gpio_put(PIN_MUX_EN,
           0); // this is critical. Others are for saving relay themselves.
  gpio_put(PIN_MUX_POL, 0);
  gpio_put(PIN_MUX_WG, 0);
  sleep_ms(RELAY_MAX_SETTLE_TIME_MS);
  gpio_put(PIN_LED_POWER, 0); // now electrodes are disconnected for sure.

  // Stop spurious signals.
  set_thresh_level(0); // no effect, but just settle on known state.

  while (true) {
    // "error blink" forever
    gpio_put(PIN_LED_POWER, 1);
    sleep_ms(LED_ERR_BLINK_ON_MS);
    gpio_put(PIN_LED_POWER, 0);
    sleep_ms(LED_ERR_BLINK_OFF_MS);
  }
}

// core0
int main() {
  // Init compute.
  uint8_t th_cyc_on_reset = compute_th_on_cyc(PCURR_ON_RESET);
  csec_pulse_pol = POL_OFF;
  csec_pulse_pcurr = PCURR_ON_RESET;
  csec_pulse_pdur = PDUR_ON_RESET;
  csec_pulse_max_duty = MAX_DUTY_ON_RESET;
  csec_pulse_th_on_cyc = th_cyc_on_reset;
  critical_section_init(&csec_pulse);
  critical_section_init(&csec_stat);

  // Init I/O to safe state.
  const uint32_t output_mask =
      (1 << PIN_LED_STATUS) | (1 << PIN_LED_POWER) | (1 << PIN_I2C_SDA) |
      (1 << PIN_I2C_SCL) | (1 << PIN_MUX_POL) | (1 << PIN_MUX_WG) |
      (1 << PIN_MUX_EN) | (1 << PIN_CURR_GATE_PWM) | (1 << PIN_CURR_THRESH_PWM);

  const uint32_t input_mask =
      (1 << PIN_GATE) | (1 << PIN_CURR_TRIGGER) | (1 << PIN_TEMP_HS);

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
  init_out_pwm();
  init_thresh_pwm(th_cyc_on_reset);
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
    if (current_temp == TEMP_INVALID || current_temp > MAX_ALLOWED_TEMP) {
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
