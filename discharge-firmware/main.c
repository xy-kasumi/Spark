#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "hardware/gpio.h"
#include "pico/stdlib.h"

#include "config.h"
#include "ed.h"
#include "md.h"

void pico_led_init() {
  gpio_init(PICO_DEFAULT_LED_PIN);
  gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
}

void pico_led_set(bool on) {
  gpio_put(PICO_DEFAULT_LED_PIN, on);
}

// flash led off for a short time.
void pico_led_flash() {
  const uint32_t LED_OFF_TIME_MS = 100;
  pico_led_set(false);
  sleep_ms(LED_OFF_TIME_MS);
  pico_led_set(true);
}

void print_time() {
  uint32_t t = to_ms_since_boot(get_absolute_time());
  uint32_t t_sec = t / 1000;
  uint32_t t_ms = t % 1000;
  printf("%d.%03d ", t_sec, t_ms);
}

void exec_command_status() {
  for (uint8_t i = 0; i < MD_NUM_BOARDS; i++) {
    md_board_status_t status = md_get_status(i);

    printf("MD %d: ", i);
    switch (status) {
      case MD_OK:
        printf("OK");
        break;
      case MD_NO_BOARD:
        printf("NO_BOARD");
        break;
      case MD_OVERTEMP:
        printf("OVERTEMP");
        break;
    }
    printf("\n");
  }

  if (ed_available()) {
    printf("ED: OK\n");
  } else {
    printf("ED: NO_BOARD\n");
  }
}

void exec_command_step(uint8_t md_ix, int step, uint32_t wait) {
  for (int i = 0; i < abs(step); i++) {
    md_step(md_ix, step > 0);
    sleep_us(wait);
  }
  print_time();
  printf("step: DONE\n");
}

void exec_command_home(uint8_t md_ix, bool dir_plus, int timeout_ms) {
  int64_t timeout_us = timeout_ms * 1000;
  const int WAIT_US =
      25;  // about 1 rotation/sec, assuming 1.8deg/step & 256 microstep.

  absolute_time_t t0 = get_absolute_time();
  int i = 0;
  while (true) {
    absolute_time_t t1 = get_absolute_time();
    int64_t elapsed_us = absolute_time_diff_us(t0, t1);
    if (elapsed_us >= timeout_us) {
      print_time();
      printf("home: TIMEOUT\n");
      return;
    }

    md_step(md_ix, dir_plus);

    // SPI is slow, need to interleave to avoid rotation slowdown.
    if (i % 256 == 0) {
      uint32_t drv_status = md_read_register(md_ix, 0x6f);

      bool sg = (drv_status & (1 << 24)) != 0;
      uint32_t sg_result = drv_status & 0x3ff;
      if (sg && i > 1000) {
        // need to exclude small i, as initial measurement (when motor just
        // started moving) is inaccurate.
        printf("home: STALL detected i=%d\n", i);
        break;
      }
    }

    sleep_us(WAIT_US);
    i++;
  }
  print_time();
  printf("home: DONE\n");
}

void exec_command_regread(uint8_t md_ix, uint8_t addr) {
  uint32_t value = md_read_register(md_ix, addr);
  printf("board %d: reg 0x%02x = 0x%08x\n", md_ix, addr, value);
}

void exec_command_regwrite(uint8_t md_ix, uint8_t addr, uint32_t data) {
  md_write_register(md_ix, addr, data);
  printf("board %d: reg 0x%02x set to 0x%08x\n", md_ix, addr, data);
}

void exec_command_prox(uint32_t timeout_ms) {
  int64_t timeout_us = timeout_ms * 1000;

  absolute_time_t t0 = get_absolute_time();
  int i = 0;
  while (true) {
    absolute_time_t t1 = get_absolute_time();
    int64_t elapsed_us = absolute_time_diff_us(t0, t1);
    if (elapsed_us >= timeout_us) {
      break;
    }

    int value = ed_proximity();
    printf("prox: %d\n", value);
    sleep_ms(100);
  }
}

void exec_command_edon() {
  ed_to_discharge();
  printf("ED: switched to DISCHARGE\n");
}

void exec_command_edoff() {
  ed_to_sense();
  printf("ED: switched to sense\n");
}

void exec_command_find(uint8_t md_ix, float distance) {
  const uint32_t WAIT_US = 25;

  int32_t steps = abs((int32_t)(MD_STEPS_PER_MM * distance));
  bool is_plus = distance > 0;

  ed_set_current(2000);
  ed_unsafe_set_gate(true);
  int32_t ix = 0;
  bool found = false;
  absolute_time_t t_prev_step = get_absolute_time();
  while (ix < steps) {
    bool detect = ed_unsafe_get_detect();
    if (detect) {
      found = true;
      break;
    }

    absolute_time_t t1 = get_absolute_time();
    if (absolute_time_diff_us(t_prev_step, t1) >= WAIT_US) {
      md_step(md_ix, is_plus);
      ix++;
      t_prev_step = t1;
    }
  }
  ed_unsafe_set_gate(false);  // immediate turn off to avoid work damage

  print_time();
  if (found) {
    float x_mm = MD_MM_PER_STEP * ix;
    printf("find: found at %.3f\n", x_mm);
  } else {
    printf("find: not found\n");
  }
}

void exec_command_drill(uint8_t md_ix, float distance) {
  // ED constants
  const uint16_t ED_IG_US_SHORT_THRESH = 5;
  const uint16_t ED_IG_US_MAX_WAIT = 500;
  const uint16_t ED_IG_US_TARGET = 100;

  const uint16_t ed_duty_pct = 25;
  uint16_t ed_pulse_dur_us = 100;
  uint16_t ed_cooldown_us =
      (ed_pulse_dur_us * 100) / ed_duty_pct - ed_pulse_dur_us;

  // MD constants
  const float MD_INITIAL_FEED_RATE = 0.05;  // mm/sec
  const uint16_t MD_MAX_WAIT_US =
      2000;  // 0.01mm/sec (0.6mm/min ~ 1.0mm^3/min for D1.5 electrode drill)
  const uint32_t MD_MIN_WAIT_US =
      25;  // 0.78mm/sec (47mm/min ~ 83mm^3/min for D1.5 electrode drill)
  const uint32_t md_initial_wait_us =
      1e6 / (MD_INITIAL_FEED_RATE * MD_STEPS_PER_MM);
  const uint32_t MD_RETRACT_DIST_STEPS = 0.25 * MD_STEPS_PER_MM;

  /* MD component status */
  int32_t md_steps = abs((int32_t)(MD_STEPS_PER_MM * distance));
  bool md_is_plus = distance > 0;

  // 0: OK
  // 1: RETRACTING
  // 0 -> 1: successive shorts detected
  // 1 -> 0: moved by 1mm
  uint8_t md_state = 0;

  uint32_t md_wait_us = md_initial_wait_us;
  int32_t md_pos = 0;
  int32_t md_retract_steps;
  int32_t md_timer = 0;

  /* ED component status */
  // 0 -> 1: discharge condition met
  // 1 -> 2: detect become HIGH (normal discharge)
  // 1 -> 3: detect become HIGH (short circuit; too early)
  // 1 -> 0: ignition timeout
  // 2 -> 3: pulse duration ended
  // 3 -> 0: cooldown timer ended
  uint8_t ed_state = 0;  // 0: discharge-ready (OFF) 1: waiting ignition (ON) 2:
                         // discharging (ON) 3: cooldown (OFF)
  int16_t ed_timer;
  int16_t successive_shorts = 0;

  /* Time control */
  absolute_time_t t0 = get_absolute_time();
  int32_t tick = 0;

  /* Stats */
  int32_t count_tick_miss = 0;
  uint32_t count_short = 0;
  uint32_t count_timeout = 0;
  uint32_t count_pulse = 0;
  uint32_t count_retract = 0;
  int32_t last_dump_tick = 0;

  ed_set_current(2000);  // 2A

  while (md_pos < md_steps) {
    // ED (at most tens of cycles; < 200ns)
    int16_t ig_time = -1;
    switch (ed_state) {
      case 0:  // DISCHARGE-REDAY
        ed_unsafe_set_gate(true);
        ed_state = 1;
        ed_timer = 0;
        break;
      case 1:  // WAITING-IGNITION
        if (ed_timer >= ED_IG_US_MAX_WAIT) {
          // too long; reset
          ed_unsafe_set_gate(false);
          ed_state = 0;
          successive_shorts = 0;
          count_timeout++;
        } else if (ed_unsafe_get_detect()) {
          ig_time = ed_timer;
          if (ed_timer <= ED_IG_US_SHORT_THRESH) {
            // short detected; turn off immediately and cooldown
            ed_unsafe_set_gate(false);
            ed_state =
                3;  // Note: maybe better to use custom cooldown after short?
            ed_timer = 0;
            successive_shorts++;
            count_short++;
          } else {
            // normal discharge
            ed_state = 2;
            ed_timer = 0;
            successive_shorts = 0;
            count_pulse++;
          }
        }
        break;
      case 2:  // DISCHARGING
        if (ed_timer >= ed_pulse_dur_us) {
          ed_unsafe_set_gate(false);
          ed_state = 3;
          ed_timer = 0;
        }
        break;
      case 3:  // COOLDOWN
        if (ed_timer >= ed_cooldown_us) {
          ed_state = 0;
        }
        break;
    }
    ed_timer++;

    // MD (< 350ns)
    switch (md_state) {
      case 0:  // OK
        if (successive_shorts >= 5) {
          md_state = 1;
          md_retract_steps = 0;
          md_timer = 0;
          count_retract++;
        } else if (md_timer >= md_wait_us) {
          md_step(md_ix, md_is_plus);
          md_timer = 0;
          md_pos++;
        }
        break;
      case 1:  // RETRACTING
        if (md_retract_steps >= MD_RETRACT_DIST_STEPS) {
          md_state = 0;
          md_timer = 0;
        }
        if (md_timer >= MD_MIN_WAIT_US) {
          md_step(md_ix, !md_is_plus);
          md_timer = 0;
          md_pos--;
          md_retract_steps++;
        }
        break;
    }
    md_timer++;

    // Compute
    // hopefully md_wait_time oscillates such that ig_time is kept around
    // ED_IG_US_TARGET.
    if (ig_time >= 0) {
      if (ig_time < ED_IG_US_TARGET) {
        md_wait_us = md_wait_us + 1;
        if (md_wait_us >= MD_MAX_WAIT_US) {
          md_wait_us = MD_MAX_WAIT_US;
        }
      } else {
        md_wait_us = md_wait_us - 1;
        if (md_wait_us < MD_MIN_WAIT_US) {
          md_wait_us = MD_MIN_WAIT_US;
        }
      }
    }

    // wait until 1us passes.
    while (true) {
      int32_t new_tick = absolute_time_diff_us(t0, get_absolute_time());
      if (new_tick > tick) {
        if (new_tick > tick + 1) {
          count_tick_miss++;  // can happen if processing takes more than 1us.
        }
        tick = new_tick;
        break;
      }
    }

    // Debug dump every 5sec.
    // relatively safe to prolong cooldown period.
    if (ed_state == 3 && tick > last_dump_tick + 5000000) {
      print_time();
      printf(
          "drill: tick=%d step=%d wait=%d / #pulse=%d #short=%d #timeout=%d "
          "#tmiss=%d #retract=%d\n",
          tick, md_pos, md_wait_us, count_pulse, count_short, count_timeout,
          count_tick_miss, count_retract);
      last_dump_tick = tick;
    }
  }

  ed_unsafe_set_gate(false);  // turn off
  print_time();
  printf("drill: done\n");
  printf(
      "drill: tick=%d / #pulse=%d #short=%d #timeout=%d "
      "#tmiss=%d #retract=%d\n",
      tick, count_pulse, count_short, count_timeout, count_tick_miss,
      count_retract);
}

void exec_command_edeexec(uint32_t duration_ms,
                          uint16_t pulse_dur_us,
                          uint16_t current_ma,
                          uint8_t duty) {
  const uint32_t NUM_BUCKETS = 100;

  uint32_t wait_time_us = ((uint32_t)pulse_dur_us) * 100 / duty;
  uint32_t duration_us = duration_ms * 1000;

  ed_set_current(current_ma);
  absolute_time_t t0 = get_absolute_time();

  uint32_t count_pulse_success = 0;
  uint32_t count_pulse_timeout = 0;
  uint64_t accum_ig_delay = 0;
  uint32_t max_ig_delay = 0;
  uint32_t min_ig_delay = UINT32_MAX;
  uint32_t hist_ig_delay[NUM_BUCKETS];
  for (int i = 0; i < NUM_BUCKETS; i++) {
    hist_ig_delay[i] = 0;
  }

  while (absolute_time_diff_us(t0, get_absolute_time()) < duration_us) {
    uint16_t ignition_delay_us = ed_single_pulse(pulse_dur_us, 5000);
    if (ignition_delay_us == UINT16_MAX) {
      count_pulse_timeout++;
    } else {
      count_pulse_success++;
      accum_ig_delay += ignition_delay_us;
      if (ignition_delay_us > max_ig_delay) {
        max_ig_delay = ignition_delay_us;
      }
      if (ignition_delay_us < min_ig_delay) {
        min_ig_delay = ignition_delay_us;
      }
      uint16_t bucket_key = (ignition_delay_us >= NUM_BUCKETS)
                                ? (NUM_BUCKETS - 1)
                                : ignition_delay_us;
      hist_ig_delay[bucket_key]++;
    }

    sleep_us(wait_time_us);  // defensive; can subtract ignition_delay to
                             // maximize power output.
  }

  printf("pulse count: %u success, %u timeout\n", count_pulse_success,
         count_pulse_timeout);
  if (count_pulse_success > 0) {
    printf("ignition delay stats(usec):\n");
    printf("avg=%u, min=%u, max=%u\n",
           (uint32_t)(accum_ig_delay / count_pulse_success), min_ig_delay,
           max_ig_delay);
    printf("histogram: 100 buckets, [0,1),...[99,5000). 100 count values:\n");
    for (int i = 0; i < NUM_BUCKETS; i++) {
      printf("%u,", hist_ig_delay[i]);
      if (i % 50 == 49) {
        printf("\n");
      }
    }
    printf("\n");
  }

  print_time();
  printf("ED: exec done\n");
}

// supported commands
// ------------------
// each line should contain single command
// Ctrl-C or Ctrl-K during input
//   cancel current command input
//
// Generic commands
// status
//   print status of all boards
// move <board_ix> <distance>
//   move by distance
//   <board_ix>: 0, 1, 2
//   <distance>: float, distance in mm
// find <board_ix> <distance>
//   move up to distance, or until electrode touches the work.
//   uses hot electrode scan. work will be slightly damaged.
//   Must be issued after `edon`.
//   <board_ix>: 0, 1, 2
//   <distance>: float, distance in mm
// drill <board_ix> <distance>
//   drill by distance. (note actual drill depth will be less, due to tool wear)
//   Must be issued after `edon`.
//   <board_ix>: 0, 1, 2
//   <distance>: float, distance in mm
//
// MD commands
// step <board_ix> <step> <wait>
//   step one motor in one direction at constant speed
//   <board_ix>: 0, 1, 2
//   <step>: integer (-n or n), in microsteps
//   <wait>: integer, wait(microsec) after each microstep
// home <board_ix> <direction> <timeout_ms>
//   move motor to home position (where it stalls)
//   <board_ix>: 0, 1, 2
//   <direction>: - or +
//   <timeout_ms>: integer, timeout in milliseconds
// regread <board_ix> <addr>
//   read register from motor driver
//   <board_ix>: 0, 1, 2
//   <addr>: 00 to 7f (hexadecimal)
// regwrite <board_ix> <addr> <data>
//   write register to motor driver
//   <board_ix>: 0, 1, 2
//   <addr>: 00 to 7f (hexadecimal)
//   <data>: 00000000 to ffffffff (hexadecimal)
//
// ED commands
// edon
//  switch ED to discharge mode
// edoff
//  switch ED to sense mode
// edexec <duration_ms> <pulse_dur_us> <current_ma> <duty>
//   <duration_ms>: duration of discharge in milliseconds
//   <pulse_dur_us>: individual pulse duration in microseconds.
//   <duty>: max duty ratio in percent (1 to 80).
//   <current>: integer, current in mA (up to 2000)
// edthot
//  execute hot disconnect test (change to sense after this)
//  WILL SHORTEN RELAY LIFE
// edtsweep <numsteps>
//  execute current sweep pulsing test
//   <numsteps>: integer, number of steps
// prox <timeout_ms>
//  sense mode command
//  dump proximity value periodically
//   <timeout_ms>: integer, timeout in milliseconds

// Try to get line.
// Does not include newline character in the buffer.
// returns true if line is read successfully.
//
// If Ctrl-C or Ctrl-K is pressed, line read is canceled; returns false.
bool stdio_getline(char* buf, size_t buf_size) {
  int ix = 0;
  while (ix < buf_size - 1) {
    char ch = stdio_getchar();
    if (ch == 3 || ch == 11) {
      return false;  // cancel waiting
    } else if (ch == '\n' || ch == '\r') {
      buf[ix] = 0;
      return true;
    } else {
      buf[ix] = ch;
      ix++;
    }
  }
}

typedef struct {
  bool success;
  int ix;
} parser_t;

/** Initializes parser and returns command. */
char* parser_init(parser_t* parser, char* str) {
  parser->success = true;
  parser->ix = 0;
  return strtok(str, " ");
}

// min & max values are inclusive.
int32_t parse_int(parser_t* parser, int32_t min, int32_t max) {
  if (!parser->success) {
    return 0;
  }

  char* str = strtok(NULL, " ");
  if (str == NULL) {
    printf("arg%d missing: expecting int", parser->ix);
    parser->success = false;
    return 0;
  }

  char* end;
  int res = strtol(str, &end, 10);
  if (str == end || *end != 0) {
    printf("arg%d invalid int", parser->ix);
    parser->success = false;
    return 0;
  }

  if (res < min || res > max) {
    printf("arg%d must be in [%d, %d]", parser->ix, min, max);
    parser->success = false;
    return 0;
  }

  parser->ix++;
  return res;
}

/** Parse hex int value. Max is inclusive. */
uint32_t parse_hex(parser_t* parser, uint32_t max) {
  if (!parser->success) {
    return 0;
  }

  char* str = strtok(NULL, " ");
  if (str == NULL) {
    printf("arg%d missing: expecting hex", parser->ix);
    parser->success = false;
    return false;
  }

  char* end;
  int res = strtol(str, &end, 16);
  if (str == end || *end != 0) {
    printf("invalid hex\n");
    parser->success = false;
    return false;
  }

  if (res > max) {
    printf("arg%d must be <= %x", parser->ix, max);
    parser->success = false;
    return false;
  }

  parser->ix++;
  return res;
}

bool parse_dir(parser_t* parser) {
  if (!parser->success) {
    return false;
  }

  char* str = strtok(NULL, " ");
  if (str == NULL) {
    printf("arg%d missing: expecting + or -", parser->ix);
    parser->success = false;
    return false;
  }

  bool is_plus = strcmp(str, "+") == 0;
  bool is_minus = strcmp(str, "-") == 0;
  if (!is_plus && !is_minus) {
    printf("arg%d invalid direction", parser->ix);
    parser->success = false;
    return false;
  }

  parser->ix++;
  return is_plus;
}

float parse_float(parser_t* parser) {
  if (!parser->success) {
    return 0;
  }

  char* str = strtok(NULL, " ");
  if (str == NULL) {
    printf("arg%d missing: expecting float", parser->ix);
    parser->success = false;
    return 0;
  }

  char* end;
  float res = strtof(str, &end);
  if (str == end || *end != 0) {
    printf("arg%d invalid float", parser->ix);
    parser->success = false;
    return 0;
  }

  parser->ix++;
  return res;
}

/**
 * Tries to execute a single command. Errors will be printed to stdout.
 * @param buf command string, without newlines. will be modified during parsing.
 */
void try_exec_command(char* buf) {
  parser_t parser;
  char* command = parser_init(&parser, buf);

  if (strcmp(command, "status") == 0) {
    exec_command_status();
  } else if (strcmp(command, "step") == 0) {
    uint8_t md_ix = parse_int(&parser, 0, MD_NUM_BOARDS - 1);
    int step = parse_int(&parser, -1000000, 1000000);
    uint32_t wait = parse_int(&parser, 0, 1000000);
    if (!parser.success) {
      return;
    }
    exec_command_step(md_ix, step, wait);
  } else if (strcmp(command, "move") == 0) {
    uint8_t md_ix = parse_int(&parser, 0, MD_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_step(md_ix, distance * MD_STEPS_PER_MM, 25);
  } else if (strcmp(command, "home") == 0) {
    uint8_t md_ix = parse_int(&parser, 0, MD_NUM_BOARDS - 1);
    bool dir_plus = parse_dir(&parser);
    int timeout_ms = parse_int(&parser, 0, 1000000);
    if (!parser.success) {
      return;
    }
    exec_command_home(md_ix, dir_plus, timeout_ms);
  } else if (strcmp(command, "regread") == 0) {
    uint8_t md_ix = parse_int(&parser, 0, MD_NUM_BOARDS - 1);
    uint8_t addr = parse_hex(&parser, 0x7f);
    if (!parser.success) {
      return;
    }
    exec_command_regread(md_ix, addr);
  } else if (strcmp(command, "regwrite") == 0) {
    uint8_t md_ix = parse_int(&parser, 0, MD_NUM_BOARDS - 1);
    uint8_t addr = parse_hex(&parser, 0x7f);
    uint32_t data = parse_hex(&parser, 0xffffffff);
    if (!parser.success) {
      return;
    }
    exec_command_regwrite(md_ix, addr, data);
  } else if (strcmp(command, "prox") == 0) {
    uint32_t timeout_ms = parse_int(&parser, 0, 1000000);
    if (!parser.success) {
      return;
    }
    exec_command_prox(timeout_ms);
  } else if (strcmp(command, "edon") == 0) {
    exec_command_edon();
  } else if (strcmp(command, "edoff") == 0) {
    exec_command_edoff();
  } else if (strcmp(command, "find") == 0) {
    uint8_t md_ix = parse_int(&parser, 0, MD_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_find(md_ix, distance);
  } else if (strcmp(command, "drill") == 0) {
    uint8_t md_ix = parse_int(&parser, 0, MD_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_drill(md_ix, distance);
  } else if (strcmp(command, "edexec") == 0) {
    uint32_t duration_ms = parse_int(&parser, 1, 1000000);
    uint16_t pulse_dur_us = parse_int(&parser, 1, 10000);
    uint16_t current_ma = parse_int(&parser, 1, 2000);
    uint8_t duty = parse_int(&parser, 0, 80);
    if (!parser.success) {
      return;
    }
    exec_command_edeexec(duration_ms, pulse_dur_us, current_ma, duty);
  } else if (strcmp(command, "edthot") == 0) {
    ed_test_hot_disconnect();
  } else if (strcmp(command, "edtsweep") == 0) {
    uint32_t numsteps = parse_int(&parser, 0, 1000000);
    if (!parser.success) {
      return;
    }
    ed_test_sweep(numsteps);
  } else {
    printf("unknown command\n");
  }
}

int main() {
  // init compute
  stdio_init_all();

  // init I/O
  pico_led_init();
  ed_init();  // in r0, MD noise disrupts ED SENSE_CURR, thus detection of the
              // ED board. Thus, ed must be initialized before MD.
  md_init();

  pico_led_set(true);  // I/O init complete
  print_time();
  printf("init OK\n");
  exec_command_status();

  // main command loop
  char buf[32];
  while (true) {
    bool success = stdio_getline(buf, sizeof(buf));
    printf("\n");
    print_time();

    if (!success) {
      printf("command canceled\n");
      continue;
    }
    printf("processing command\n");
    pico_led_flash();
    try_exec_command(buf);
  }
}
