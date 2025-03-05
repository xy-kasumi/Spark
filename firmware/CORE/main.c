// SPDX-License-Identifier: AGPL-3.0-or-later
#include "hardware/gpio.h"
#include "pico/stdlib.h"
#include <ctype.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "pulser.h"
#include "stpdrv.h"

typedef struct {
  uint32_t pulse_dur_us;
  uint8_t duty_pct;
  uint16_t current_ma;
} ctrl_config_t;

void pico_led_init() {
  gpio_init(PICO_DEFAULT_LED_PIN);
  gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
}

void pico_led_set(bool on) { gpio_put(PICO_DEFAULT_LED_PIN, on); }

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

void exec_command_status(ctrl_config_t* config) {
  for (uint8_t i = 0; i < STPDRV_NUM_BOARDS; i++) {
    stpdrv_board_status_t status = stpdrv_get_status(i);

    printf("MD %d: ", i);
    switch (status) {
    case STPDRV_OK:
      printf("OK");
      break;
    case STPDRV_NO_BOARD:
      printf("NO_BOARD");
      break;
    case STPDRV_OVERTEMP:
      printf("OVERTEMP");
      break;
    }
    printf("\n");
  }

  char pulser_state[64];
  pulser_dump_state(pulser_state, sizeof(pulser_state));
  printf("ED: %s\n", pulser_state);

  printf("PULSE: dur_us=%u, duty=%u, curr_ma=%u\n", config->pulse_dur_us,
         config->duty_pct, config->current_ma);
}

void exec_command_step(uint8_t stpdrv_ix, int step, uint32_t wait) {
  for (int i = 0; i < abs(step); i++) {
    stpdrv_step(stpdrv_ix, step > 0);
    sleep_us(wait);
  }
  print_time();
  printf("step: DONE\n");
}

void exec_command_regread(char board_id, uint8_t addr) {
  if (board_id == 'E') {
    uint8_t value = pulser_read_register(addr);
    printf("board E: reg 0x%02x = 0x%02x (%d)\n", addr, value, value);
  } else {
    uint32_t value = stpdrv_read_register(board_id - '0', addr);
    printf("board %c: reg 0x%02x = 0x%08x\n", board_id, addr, value);
  }
}

void exec_command_regwrite(char board_id, uint8_t addr, uint32_t data) {
  if (board_id == 'E') {
    pulser_write_register(addr, (uint8_t)data);
    printf("board E: reg 0x%02x set to 0x%02x\n", addr, (uint8_t)data);
  } else {
    stpdrv_write_register(board_id - '0', addr, data);
    printf("board %c: reg 0x%02x set to 0x%08x\n", board_id, addr, data);
  }
}

void exec_command_find(uint8_t stpdrv_ix, float distance) {
  int32_t steps = abs((int32_t)(STEPS_PER_MM * distance));
  bool is_plus = distance > 0;

  pulser_set_current(100);
  pulser_set_energize(true);
  pulser_unsafe_set_gate(true);
  int32_t ix = 0;
  bool found = false;
  absolute_time_t t_prev_step = get_absolute_time();
  while (ix < steps) {
    bool detect = pulser_unsafe_get_detect();
    if (detect) {
      found = true;
      break;
    }

    absolute_time_t t1 = get_absolute_time();
    if (absolute_time_diff_us(t_prev_step, t1) >= FIND_WAIT_US) {
      stpdrv_step(stpdrv_ix, is_plus);
      ix++;
      t_prev_step = t1;
    }
  }
  pulser_unsafe_set_gate(false); // immediate turn off to avoid work damage

  print_time();
  if (found) {
    float x_mm = MM_PER_STEP * ix;
    printf("find: found at %.3f\n", x_mm);
  } else {
    printf("find: not found\n");
  }
  pulser_set_energize(false);
}

typedef enum {
  STPDRV_DRILL_OK = 0,
  STPDRV_DRILL_PULL = 1,
  STPDRV_DRILL_PUSH = 2,
} stpdrv_drill_state_t;

typedef struct {
  int8_t board_ix;
  bool is_plus;
  int32_t steps;

  stpdrv_drill_state_t state;
  int32_t pos;
  uint32_t wait_us;

  uint32_t pullpush_wait_us;
  int32_t pullpush_curr_steps;
  int32_t pull_target_steps;
  int32_t push_target_steps;

  int32_t timer;
} stpdrv_drill_t;

typedef enum {
  PULSER_DRILL_WAITING_IGNITION = 1,
  PULSER_DRILL_DISCHARGING = 2,
  PULSER_DRILL_COOLDOWN = 3,
  PULSER_DRILL_SHORT_COOLDOWN = 4,
} pulser_drill_state_t;

typedef struct {
  pulser_drill_state_t state;
  int16_t successive_shorts;
  int32_t timer;

  uint16_t pulse_dur_us;
  uint16_t cooldown_us;
} pulser_drill_t;

typedef struct {
  int32_t n_tick_miss;
  uint32_t n_short;
  uint32_t n_pulse;
  uint32_t n_retract;
  int64_t last_dump_tick;

  uint64_t accum_ig_delay;
  uint64_t cnt_ig_delay;
  uint16_t max_ig_delay;
  uint16_t min_ig_delay;

  uint32_t max_successive_short;
} drill_stats_t;

static const uint16_t PULSER_IG_US_TARGET = 200;

void reset_ig_delay(drill_stats_t* stats) {
  stats->accum_ig_delay = 0;
  stats->cnt_ig_delay = 0;
  stats->max_ig_delay = 0;
  stats->min_ig_delay = UINT16_MAX;
}

void init_drill_stats(drill_stats_t* stats) {
  stats->n_tick_miss = 0;
  stats->n_short = 0;
  stats->n_pulse = 0;
  stats->n_retract = 0;
  stats->last_dump_tick = 0;
  stats->max_successive_short = 0;
  reset_ig_delay(stats);
}

void record_ig_delay(drill_stats_t* stats, uint16_t ig_delay) {
  stats->accum_ig_delay += ig_delay;
  stats->cnt_ig_delay++;
  if (ig_delay > stats->max_ig_delay) {
    stats->max_ig_delay = ig_delay;
  }
  if (ig_delay < stats->min_ig_delay) {
    stats->min_ig_delay = ig_delay;
  }
}

/** Must be called when ed.state == STPDRV_DRILL_OK. */
void stpdrv_to_pullpush(stpdrv_drill_t* md, int32_t pull_steps,
                        int32_t push_steps, uint32_t wait_us) {
  md->state = STPDRV_DRILL_PULL;
  md->pullpush_curr_steps = 0;
  md->pull_target_steps = pull_steps;
  md->push_target_steps = push_steps;
  md->pullpush_wait_us = wait_us;
  md->timer = 0;
}

void init_stpdrv_drill(stpdrv_drill_t* md, uint8_t stpdrv_ix, float distance) {
  // MD constants
  const float STPDRV_INITIAL_FEED_RATE = 0.05; // mm/sec

  const uint32_t stpdrv_initial_wait_us =
      1e6 / (STPDRV_INITIAL_FEED_RATE * STEPS_PER_MM);

  md->board_ix = stpdrv_ix;
  md->is_plus = distance > 0;
  md->steps = abs((int32_t)(STEPS_PER_MM * distance));

  md->state = STPDRV_DRILL_OK;
  md->wait_us = stpdrv_initial_wait_us;
  md->pos = 0;
  md->timer = 0;
}

void tick_stpdrv_drill(stpdrv_drill_t* md, drill_stats_t* stats) {
  switch (md->state) {
  case STPDRV_DRILL_OK:
    if (md->timer >= md->wait_us) {
      stpdrv_step(md->board_ix, md->is_plus);
      md->timer = 0;
      md->pos++;
    }
    break;
  case STPDRV_DRILL_PULL:
    if (md->pullpush_curr_steps >= md->pull_target_steps) {
      md->state = STPDRV_DRILL_PUSH;
      md->timer = 0;
      md->pullpush_curr_steps = 0;
    } else if (md->timer >= md->pullpush_wait_us) {
      stpdrv_step(md->board_ix, !md->is_plus);
      md->timer = 0;
      md->pos--;
      md->pullpush_curr_steps++;
    }
    break;
  case STPDRV_DRILL_PUSH:
    if (md->pullpush_curr_steps >= md->push_target_steps) {
      md->state = STPDRV_DRILL_OK;
      md->timer = 0;
    } else if (md->timer >= md->pullpush_wait_us) {
      stpdrv_step(md->board_ix, md->is_plus);
      md->timer = 0;
      md->pos++;
      md->pullpush_curr_steps++;
    }
    break;
  }
  md->timer++;
}

void init_pulser_drill(pulser_drill_t* ed, uint16_t pulse_dur_us,
                       uint8_t duty_pct) {
  ed->state = PULSER_DRILL_WAITING_IGNITION;
  ed->successive_shorts = 0;

  ed->pulse_dur_us = pulse_dur_us;
  ed->cooldown_us = (pulse_dur_us * 100) / ((uint16_t)duty_pct) - pulse_dur_us;
}

/**
 * Execute single tick of ED drill.
 *
 * @param [out] ig_time ignition time in us. -1 means no ignition. 10000 means
 * timeout.
 */
void tick_pulser_drill(pulser_drill_t* ed, drill_stats_t* stats,
                       uint16_t* ig_time) {
  const uint16_t PULSER_SHORT_COOLDOWN_US = 1000;

  const uint16_t PULSER_IG_US_SHORT_THRESH = 5;
  const uint16_t PULSER_IG_US_MAX_WAIT = 500;

  *ig_time = -1;
  switch (ed->state) {
  case PULSER_DRILL_WAITING_IGNITION:
    pulser_unsafe_set_gate(true);

    if (ed->timer >= PULSER_IG_US_MAX_WAIT) {
      // too long; reset
      ed->state = PULSER_DRILL_WAITING_IGNITION;
      ed->timer = 0;
      ed->successive_shorts = 0;
      *ig_time = 10000; // timeout
    } else if (pulser_unsafe_get_detect()) {
      *ig_time = ed->timer;
      if (ed->timer <= PULSER_IG_US_SHORT_THRESH) {
        // short detected; immediately enter cooldown
        ed->state = PULSER_DRILL_SHORT_COOLDOWN;
        ed->timer = 0;
        ed->successive_shorts++;
        if (ed->successive_shorts > stats->max_successive_short) {
          stats->max_successive_short = ed->successive_shorts;
        }
        stats->n_short++;
      } else {
        // normal discharge
        ed->state = PULSER_DRILL_DISCHARGING;
        ed->timer = 0;
        ed->successive_shorts = 0;
        stats->n_pulse++;
        record_ig_delay(stats, *ig_time);
      }
    }
    break;
  case PULSER_DRILL_DISCHARGING:
    pulser_unsafe_set_gate(true);
    if (ed->timer >= ed->pulse_dur_us) {
      ed->state = PULSER_DRILL_COOLDOWN;
      ed->timer = 0;
    }
    break;
  case PULSER_DRILL_COOLDOWN:
    pulser_unsafe_set_gate(false);
    if (ed->timer >= ed->cooldown_us) {
      ed->state = PULSER_DRILL_WAITING_IGNITION;
      ed->timer = 0;
    }
    break;
  case PULSER_DRILL_SHORT_COOLDOWN:
    pulser_unsafe_set_gate(false);
    if (ed->timer >= PULSER_SHORT_COOLDOWN_US) {
      ed->state = PULSER_DRILL_WAITING_IGNITION;
      ed->timer = 0;
    }
    break;
  }
  ed->timer++;
}

void drill_print_stats(int64_t tick, stpdrv_drill_t* md, pulser_drill_t* ed,
                       drill_stats_t* stats) {
  print_time();
  int32_t avg_ig = -1;
  int32_t min_ig = -1;
  int32_t max_ig = -1;
  if (stats->cnt_ig_delay > 0) {
    avg_ig = stats->accum_ig_delay / stats->cnt_ig_delay;
    min_ig = stats->min_ig_delay;
    max_ig = stats->max_ig_delay;
  }
  printf("drill: tick=%" PRId64 " step=%d wait=%d #pulse=%d #short=%d "
         "#retract=%d / max_short=%d avg_ig=%d min_ig=%d max_ig=%d\n",
         tick, md->pos, md->wait_us, stats->n_pulse, stats->n_short,
         stats->n_retract, stats->max_successive_short, avg_ig, min_ig, max_ig);

  reset_ig_delay(stats);
  stats->max_successive_short = 0;

  stats->last_dump_tick = tick;
}

void exec_command_drill(uint8_t stpdrv_ix, float distance,
                        ctrl_config_t* config) {
  const uint32_t STPDRV_RETRACT_DIST_STEPS = 10e-3 * STEPS_PER_MM; // 10um

  stpdrv_drill_t md;
  init_stpdrv_drill(&md, stpdrv_ix, distance);

  uint32_t PUMP_STEPS = md.steps + (uint32_t)(0.5 * STEPS_PER_MM);

  pulser_drill_t ed;
  init_pulser_drill(&ed, config->pulse_dur_us, config->duty_pct);

  const int32_t PUMP_PULSE_INTERVAL = 10000;
  int32_t last_pump_pulse = 0;

  absolute_time_t t0 = get_absolute_time();
  int64_t tick = 0;

  drill_stats_t stats;
  init_drill_stats(&stats);

  pulser_set_current(config->current_ma);
  pulser_set_energize(true);
  while (md.pos < md.steps) {
    /* Exec */
    uint16_t ig_time;
    tick_pulser_drill(&ed, &stats, &ig_time); // < 200ns
    tick_stpdrv_drill(&md, &stats);           // < 350ns

    /* Compute */
    if (ed.successive_shorts >= 1000) {
      // CONTINUED short; abort
      pulser_unsafe_set_gate(false);
      pulser_set_energize(false);
      print_time();
      printf("drill: ABORTED due to continued 10000 shorts\n");
      return;
    }

    // TODO: this is very fragile and ad-hoc control code. improve.
    // hopefully stpdrv_wait_time oscillates such that ig_time is kept around
    // PULSER_IG_US_TARGET.
    if (md.state == STPDRV_DRILL_OK && ig_time >= 0) {
      if (ig_time < PULSER_IG_US_TARGET) {
        md.wait_us = md.wait_us + FEED_DELTA_WAIT_US;
        if (md.wait_us >= FEED_MAX_WAIT_US) {
          md.wait_us = FEED_MAX_WAIT_US;
        }
      } else {
        md.wait_us = md.wait_us - FEED_DELTA_WAIT_US;
        if (md.wait_us < FEED_MIN_WAIT_US) {
          md.wait_us = FEED_MIN_WAIT_US;
        }
      }
    }

    if (md.state == STPDRV_DRILL_OK) {
      if (stats.n_pulse >= last_pump_pulse + PUMP_PULSE_INTERVAL) {
        stpdrv_to_pullpush(&md, PUMP_STEPS, PUMP_STEPS, MOVE_WAIT_US);
        last_pump_pulse = stats.n_pulse;
      } else if (ed.successive_shorts >= 5) {
        md.wait_us = FEED_MIN_WAIT_US * 50;
        stpdrv_to_pullpush(&md, STPDRV_RETRACT_DIST_STEPS, 0, MOVE_WAIT_US);
        stats.n_retract++;
        ed.successive_shorts = 0;
      } else if (ed.successive_shorts >= 1) {
        md.wait_us = FEED_MIN_WAIT_US * 10;
      }
    }

    /* Debug dump every 1.0 sec. */
    // relatively safe to prolong cooldown period.
    if (ed.state != PULSER_DRILL_DISCHARGING &&
        tick > stats.last_dump_tick + 1000000) {
      drill_print_stats(tick, &md, &ed, &stats);
    }

    // wait until 1us passes.
    while (true) {
      int64_t new_tick = absolute_time_diff_us(t0, get_absolute_time());
      if (new_tick > tick) {
        if (new_tick > tick + 1) {
          stats.n_tick_miss++; // when processing takes more than 1us.
        }
        tick = new_tick;
        break;
      }
    }
  }

  pulser_unsafe_set_gate(false); // turn off
  pulser_set_energize(false);
  print_time();
  printf("drill: done\n");
  drill_print_stats(tick, &md, &ed, &stats);
  printf("drill: #tmiss=%d\n", stats.n_tick_miss);
}

void exec_command_edparam(uint32_t pulse_dur_us, uint8_t duty_pct,
                          uint16_t curr_ma, ctrl_config_t* config) {
  config->pulse_dur_us = pulse_dur_us;
  config->duty_pct = duty_pct;
  config->current_ma = curr_ma;

  print_time();
  printf("New pulse config: dur_us=%u, duty=%u%%, curr_ma=%u\n",
         config->pulse_dur_us, config->duty_pct, config->current_ma);
}

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
      return false; // cancel waiting
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
    printf("arg%d missing: expecting int\n", parser->ix);
    parser->success = false;
    return 0;
  }

  char* end;
  int res = strtol(str, &end, 10);
  if (str == end || *end != 0) {
    printf("arg%d invalid int\n", parser->ix);
    parser->success = false;
    return 0;
  }

  if (res < min || res > max) {
    printf("arg%d must be in [%d, %d]\n", parser->ix, min, max);
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
    printf("arg%d missing: expecting hex\n", parser->ix);
    parser->success = false;
    return false;
  }

  char* end;
  int res = strtol(str, &end, 16);
  if (str == end || *end != 0) {
    printf("arg%d: invalid hex\n");
    parser->success = false;
    return false;
  }

  if (res > max) {
    printf("arg%d must be <= %x\n", parser->ix, max);
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
    printf("arg%d missing: expecting + or -\n", parser->ix);
    parser->success = false;
    return false;
  }

  bool is_plus = strcmp(str, "+") == 0;
  bool is_minus = strcmp(str, "-") == 0;
  if (!is_plus && !is_minus) {
    printf("arg%d invalid direction\n", parser->ix);
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
    printf("arg%d missing: expecting float\n", parser->ix);
    parser->success = false;
    return 0;
  }

  char* end;
  float res = strtof(str, &end);
  if (str == end || *end != 0) {
    printf("arg%d invalid float\n", parser->ix);
    parser->success = false;
    return 0;
  }

  parser->ix++;
  return res;
}

char parse_board_id(parser_t* parser) {
  if (!parser->success) {
    return 'X';
  }

  char* str = strtok(NULL, " ");
  if (str == NULL) {
    printf("arg%d missing: expecting board_id (0/1/2/E)\n", parser->ix);
    parser->success = false;
    return 'X';
  }

  if (strlen(str) >= 2) {
    printf("arg%d invalid board_id\n", parser->ix);
    parser->success = false;
    return 'X';
  }

  char ch = str[0];
  if (ch != '0' && ch != '1' && ch != '2' && ch != 'E') {
    printf("arg%d invalid board_id\n", parser->ix);
    parser->success = false;
    return 'X';
  }

  parser->ix++;
  return ch;
}

/**
 * Tries to execute a single command. Errors will be printed to stdout.
 * @param buf command string, without newlines. will be modified during parsing.
 */
void try_exec_command(char* buf, ctrl_config_t* config) {
  parser_t parser;
  char* command = parser_init(&parser, buf);

  if (strcmp(command, "status") == 0) {
    exec_command_status(config);
  } else if (strcmp(command, "move") == 0) {
    uint8_t stpdrv_ix = parse_int(&parser, 0, STPDRV_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_step(stpdrv_ix, distance * STEPS_PER_MM, MOVE_WAIT_US);
  } else if (strcmp(command, "edparam") == 0) {
    uint16_t pulse_dur_us = parse_int(&parser, 5, 10000);
    uint8_t duty_pct = parse_int(&parser, 1, 50);
    uint16_t curr_ma = parse_int(&parser, 100, 8000);
    if (!parser.success) {
      return;
    }
    exec_command_edparam(pulse_dur_us, duty_pct, curr_ma, config);
  } else if (strcmp(command, "regread") == 0) {
    char board_id = parse_board_id(&parser);
    uint8_t addr = parse_hex(&parser, 0x7f);
    if (!parser.success) {
      return;
    }
    exec_command_regread(board_id, addr);
  } else if (strcmp(command, "regwrite") == 0) {
    char board_id = parse_board_id(&parser);
    uint8_t addr = parse_hex(&parser, 0x7f);
    uint32_t data = parse_hex(&parser, 0xffffffff);
    if (!parser.success) {
      return;
    }
    exec_command_regwrite(board_id, addr, data);
  } else if (strcmp(command, "find") == 0) {
    uint8_t stpdrv_ix = parse_int(&parser, 0, STPDRV_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_find(stpdrv_ix, distance);
  } else if (strcmp(command, "drill") == 0) {
    uint8_t stpdrv_ix = parse_int(&parser, 0, STPDRV_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_drill(stpdrv_ix, distance, config);
  } else {
    printf("unknown command\n");
  }
}

typedef struct {
  // top-level control
  int32_t mot_targ_pos_um;
  uint8_t stpdrv_ix;

  // for motor control loop internal
  int32_t mot_curr_pos_um;
  int8_t remaining_steps;
  uint16_t us_between_steps;
} control_t;

// Distribute steps evenly in loop interval.
int64_t control_loop_step_motor(alarm_id_t aid, void* data) {
  control_t* control = data;
  if (control->remaining_steps > 0) {
    stpdrv_step(control->stpdrv_ix, true);
    control->remaining_steps--;
  } else {
    stpdrv_step(control->stpdrv_ix, false);
    control->remaining_steps++;
  }

  if (control->remaining_steps == 0) {
    return 0; // stepping in this loop is done. cancel alarm.
  } else {
    return -control->us_between_steps; // keep periodic stepping
  }
}

void control_loop_motor(control_t* control) {
  if (control->remaining_steps != 0) {
    // uC is probably overloaded.
    // TODO: display some kind of error
    return; // keep executing previous alarm
  }

  int32_t delta = control->mot_targ_pos_um - control->mot_curr_pos_um;
  if (delta == 0) {
    return;
  }

  if (delta > MAX_STEP_IN_LOOP) {
    delta = MAX_STEP_IN_LOOP;
  } else if (delta < -MAX_STEP_IN_LOOP) {
    delta = -MAX_STEP_IN_LOOP;
  }
  control->remaining_steps = delta;
  control->us_between_steps = CONTROL_LOOP_INTERVAL_US / abs(delta);
  add_alarm_in_us(0, &control_loop_step_motor, control, true);
}

void control_loop_pulse(control_t* control) {
  // emit as much pulse as possible.
}

// Main control loop at CONTROL_LOOP_HZ.
bool control_loop(repeating_timer_t* rt) {
  control_t* control = (control_t*)rt->user_data;

  // mode-specific control code.
  if (false) {
    // drilling

    // slow loop. maximize avg. pulse duration by optimizing targ_ig.

    // fast loop. movement control to match pulse
    // fast loop. detect short and generate retract

    // trapezoidal position control
  }

  control_loop_motor(control);
  control_loop_pulse(control);

  return true;
}

int main() {
  // init compute
  stdio_init_all();
  alarm_pool_init_default();

  // init I/O
  pico_led_init();
  pulser_init(); // in r0, MD noise disrupts ED SENSE_CURR, thus detection of
                 // the ED board. Thus, ed must be initialized before MD.
  stpdrv_init();

  pico_led_set(true); // I/O init complete
  print_time();

  // init system config
  ctrl_config_t config;
  config.pulse_dur_us = 500;
  config.duty_pct = 50;
  config.current_ma = 1000;

  // start control loop
  control_t control;
  repeating_timer_t rt;
  alarm_pool_add_repeating_timer_us(alarm_pool_get_default(),
                                    CONTROL_LOOP_INTERVAL_US, &control_loop,
                                    &control, &rt);

  // report init done
  printf("init OK\n");
  exec_command_status(&config);

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
    try_exec_command(buf, &config);
  }
}
