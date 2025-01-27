#include "hardware/gpio.h"
#include "pico/stdlib.h"
#include <ctype.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "ed.h"
#include "md.h"

typedef struct {
  uint32_t pulse_dur_us;
  uint8_t duty_pct;
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
    uint8_t temp = ed_temp();
    if (temp == 255) {
      printf("ED: TEMP SENSOR ERROR\n");
    } else {
      printf("ED: OK (temp=%u C)\n", temp);
    }
  } else {
    printf("ED: NO_BOARD\n");
  }

  printf("PARAM: pulse_dur_us=%u, duty=%u\n", config->pulse_dur_us,
         config->duty_pct);
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
      25; // about 1 rotation/sec, assuming 1.8deg/step & 256 microstep.

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

void exec_command_regread(char board_id, uint8_t addr) {
  if (board_id == 'E') {
    if (!ed_available()) {
      printf("ED: NO_BOARD\n");
      return;
    }
    uint8_t value = ed_read_register(addr);
    printf("board E: reg 0x%02x = 0x%02x\n", addr, value);
  } else {
    uint32_t value = md_read_register(board_id - '0', addr);
    printf("board %c: reg 0x%02x = 0x%08x\n", board_id, addr, value);
  }
}

void exec_command_regwrite(char board_id, uint8_t addr, uint32_t data) {
  if (board_id == 'E') {
    if (!ed_available()) {
      printf("ED: NO_BOARD\n");
      return;
    }
    ed_write_register(addr, (uint8_t)data);
    printf("board E: reg 0x%02x set to 0x%02x\n", addr, (uint8_t)data);
  } else {
    md_write_register(board_id - '0', addr, data);
    printf("board %c: reg 0x%02x set to 0x%08x\n", board_id, addr, data);
  }
}

void exec_command_edon() {
  ed_set_energize(true);
  printf("ED: ENERGIZED\n");
}

void exec_command_edoff() {
  ed_set_energize(false);
  printf("ED: de-energized\n");
}

void exec_command_find(uint8_t md_ix, float distance) {
  const uint32_t WAIT_US = 25;

  int32_t steps = abs((int32_t)(MD_STEPS_PER_MM * distance));
  bool is_plus = distance > 0;

  ed_set_current(100);
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
  ed_unsafe_set_gate(false); // immediate turn off to avoid work damage

  print_time();
  if (found) {
    float x_mm = MD_MM_PER_STEP * ix;
    printf("find: found at %.3f\n", x_mm);
  } else {
    printf("find: not found\n");
  }
}

typedef enum {
  MD_DRILL_OK = 0,
  MD_DRILL_PULL = 1,
  MD_DRILL_PUSH = 2,
} md_drill_state_t;

typedef struct {
  int8_t board_ix;
  bool is_plus;
  int32_t steps;

  md_drill_state_t state;
  int32_t pos;
  uint32_t wait_us;

  uint32_t pullpush_wait_us;
  int32_t pullpush_curr_steps;
  int32_t pull_target_steps;
  int32_t push_target_steps;

  int32_t timer;
} md_drill_t;

typedef enum {
  ED_DRILL_WAITING_IGNITION = 1,
  ED_DRILL_DISCHARGING = 2,
  ED_DRILL_COOLDOWN = 3,
  ED_DRILL_SHORT_COOLDOWN = 4,
} ed_drill_state_t;

typedef struct {
  ed_drill_state_t state;
  int16_t successive_shorts;
  int32_t timer;

  uint16_t pulse_dur_us;
  uint16_t cooldown_us;
} ed_drill_t;

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

static const uint32_t MD_FEED_MAX_WAIT_US =
    10000; // 0.01mm/sec (0.6mm/min ~ 1.0mm^3/min for D1.5 electrode drill)
static const uint32_t MD_FEED_MIN_WAIT_US =
    1000; // empirically found stable value
static const uint32_t MD_MOVE_MIN_WAIT_US = 25; // 0.78mm/sec
static const uint16_t ED_IG_US_TARGET = 200;

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

/** Must be called when ed.state == MD_DRILL_OK. */
void md_to_pullpush(md_drill_t* md, int32_t pull_steps, int32_t push_steps,
                    uint32_t wait_us) {
  md->state = MD_DRILL_PULL;
  md->pullpush_curr_steps = 0;
  md->pull_target_steps = pull_steps;
  md->push_target_steps = push_steps;
  md->pullpush_wait_us = wait_us;
  md->timer = 0;
}

void init_md_drill(md_drill_t* md, uint8_t md_ix, float distance) {
  // MD constants
  const float MD_INITIAL_FEED_RATE = 0.05; // mm/sec

  const uint32_t md_initial_wait_us =
      1e6 / (MD_INITIAL_FEED_RATE * MD_STEPS_PER_MM);

  md->board_ix = md_ix;
  md->is_plus = distance > 0;
  md->steps = abs((int32_t)(MD_STEPS_PER_MM * distance));

  md->state = MD_DRILL_OK;
  md->wait_us = md_initial_wait_us;
  md->pos = 0;
  md->timer = 0;
}

void tick_md_drill(md_drill_t* md, drill_stats_t* stats) {
  switch (md->state) {
  case MD_DRILL_OK:
    if (md->timer >= md->wait_us) {
      md_step(md->board_ix, md->is_plus);
      md->timer = 0;
      md->pos++;
    }
    break;
  case MD_DRILL_PULL:
    if (md->pullpush_curr_steps >= md->pull_target_steps) {
      md->state = MD_DRILL_PUSH;
      md->timer = 0;
      md->pullpush_curr_steps = 0;
    } else if (md->timer >= md->pullpush_wait_us) {
      md_step(md->board_ix, !md->is_plus);
      md->timer = 0;
      md->pos--;
      md->pullpush_curr_steps++;
    }
    break;
  case MD_DRILL_PUSH:
    if (md->pullpush_curr_steps >= md->push_target_steps) {
      md->state = MD_DRILL_OK;
      md->timer = 0;
    } else if (md->timer >= md->pullpush_wait_us) {
      md_step(md->board_ix, md->is_plus);
      md->timer = 0;
      md->pos++;
      md->pullpush_curr_steps++;
    }
    break;
  }
  md->timer++;
}

void init_ed_drill(ed_drill_t* ed, uint16_t pulse_dur_us, uint8_t duty_pct) {
  ed->state = ED_DRILL_WAITING_IGNITION;
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
void tick_ed_drill(ed_drill_t* ed, drill_stats_t* stats, uint16_t* ig_time) {
  const uint16_t ED_SHORT_COOLDOWN_US = 1000;

  const uint16_t ED_IG_US_SHORT_THRESH = 3;
  const uint16_t ED_IG_US_MAX_WAIT = 500;

  *ig_time = -1;
  switch (ed->state) {
  case ED_DRILL_WAITING_IGNITION:
    ed_unsafe_set_gate(true);

    if (ed->timer >= ED_IG_US_MAX_WAIT) {
      // too long; reset
      ed->state = ED_DRILL_WAITING_IGNITION;
      ed->timer = 0;
      ed->successive_shorts = 0;
      *ig_time = 10000; // timeout
    } else if (ed_unsafe_get_detect()) {
      *ig_time = ed->timer;
      if (ed->timer <= ED_IG_US_SHORT_THRESH) {
        // short detected; immediately enter cooldown
        ed->state = ED_DRILL_SHORT_COOLDOWN;
        ed->timer = 0;
        ed->successive_shorts++;
        if (ed->successive_shorts > stats->max_successive_short) {
          stats->max_successive_short = ed->successive_shorts;
        }
        stats->n_short++;
      } else {
        // normal discharge
        ed->state = ED_DRILL_DISCHARGING;
        ed->timer = 0;
        ed->successive_shorts = 0;
        stats->n_pulse++;
        record_ig_delay(stats, *ig_time);
      }
    }
    break;
  case ED_DRILL_DISCHARGING:
    ed_unsafe_set_gate(true);
    if (ed->timer >= ed->pulse_dur_us) {
      ed->state = ED_DRILL_COOLDOWN;
      ed->timer = 0;
    }
    break;
  case ED_DRILL_COOLDOWN:
    ed_unsafe_set_gate(false);
    if (ed->timer >= ed->cooldown_us) {
      ed->state = ED_DRILL_WAITING_IGNITION;
      ed->timer = 0;
    }
    break;
  case ED_DRILL_SHORT_COOLDOWN:
    ed_unsafe_set_gate(false);
    if (ed->timer >= ED_SHORT_COOLDOWN_US) {
      ed->state = ED_DRILL_WAITING_IGNITION;
      ed->timer = 0;
    }
    break;
  }
  ed->timer++;
}

void drill_print_stats(int64_t tick, md_drill_t* md, ed_drill_t* ed,
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

void exec_command_drill(uint8_t md_ix, float distance, ctrl_config_t* config) {
  const uint32_t MD_RETRACT_DIST_STEPS = 10e-3 * MD_STEPS_PER_MM; // 10um

  md_drill_t md;
  init_md_drill(&md, md_ix, distance);

  uint32_t PUMP_STEPS = md.steps + (uint32_t)(0.5 * MD_STEPS_PER_MM);

  ed_drill_t ed;
  init_ed_drill(&ed, config->pulse_dur_us, config->duty_pct);

  const int32_t PUMP_PULSE_INTERVAL = 10000;
  int32_t last_pump_pulse = 0;

  absolute_time_t t0 = get_absolute_time();
  int64_t tick = 0;

  drill_stats_t stats;
  init_drill_stats(&stats);

  ed_set_current(2000); // 2A
  while (md.pos < md.steps) {
    /* Exec */
    uint16_t ig_time;
    tick_ed_drill(&ed, &stats, &ig_time); // < 200ns
    tick_md_drill(&md, &stats);           // < 350ns

    /* Compute */
    if (ed.successive_shorts >= 1000) {
      // CONTINUED short; abort
      ed_unsafe_set_gate(false);
      print_time();
      printf("drill: ABORTED due to continued 10000 shorts\n");
      return;
    }

    // hopefully md_wait_time oscillates such that ig_time is kept around
    // ED_IG_US_TARGET.
    if (md.state == MD_DRILL_OK && ig_time >= 0) {
      if (ig_time < ED_IG_US_TARGET) {
        md.wait_us = md.wait_us + 1;
        if (md.wait_us >= MD_FEED_MAX_WAIT_US) {
          md.wait_us = MD_FEED_MAX_WAIT_US;
        }
      } else {
        md.wait_us = md.wait_us - 1;
        if (md.wait_us < MD_FEED_MIN_WAIT_US) {
          md.wait_us = MD_FEED_MIN_WAIT_US;
        }
      }
    }

    if (md.state == MD_DRILL_OK) {
      if (stats.n_pulse >= last_pump_pulse + PUMP_PULSE_INTERVAL) {
        md_to_pullpush(&md, PUMP_STEPS, PUMP_STEPS, MD_MOVE_MIN_WAIT_US);
        last_pump_pulse = stats.n_pulse;
      } else if (ed.successive_shorts >= 5) {
        md.wait_us = 5000;
        md_to_pullpush(&md, MD_RETRACT_DIST_STEPS, 0, MD_MOVE_MIN_WAIT_US);
        stats.n_retract++;
        ed.successive_shorts = 0;
      } else if (ed.successive_shorts >= 1) {
        md.wait_us = 2000;
      }
    }

    /* Debug dump every 1.0 sec. */
    // relatively safe to prolong cooldown period.
    if (ed.state != ED_DRILL_DISCHARGING &&
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

  ed_unsafe_set_gate(false); // turn off
  print_time();
  printf("drill: done\n");
  drill_print_stats(tick, &md, &ed, &stats);
  printf("drill: #tmiss=%d\n", stats.n_tick_miss);
}

void exec_command_edeexec(uint32_t duration_ms, uint16_t pulse_dur_us,
                          uint16_t current_ma, uint8_t duty_pct) {
  const uint32_t NUM_BUCKETS = 100;

  uint32_t wait_time_us = ((uint32_t)pulse_dur_us) * 100 / duty_pct;
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

    sleep_us(wait_time_us); // defensive; can subtract ignition_delay to
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

void exec_command_edparam(uint32_t pulse_dur_us, uint8_t duty_pct,
                          ctrl_config_t* config) {
  config->pulse_dur_us = pulse_dur_us;
  config->duty_pct = duty_pct;

  print_time();
  printf("New config: pulse_dur_us=%u, duty=%u%%\n", pulse_dur_us, duty_pct);
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

char parse_board_id(parser_t* parser) {
  if (!parser->success) {
    return 'X';
  }

  char* str = strtok(NULL, " ");
  if (str == NULL) {
    printf("arg%d missing: expecting board_id (0/1/2/E)", parser->ix);
    parser->success = false;
    return 'X';
  }

  if (strlen(str) >= 2) {
    printf("arg%d invalid board_id", parser->ix);
    parser->success = false;
    return 'X';
  }

  char ch = str[0];
  if (ch != '0' && ch != '1' && ch != '2' && ch != 'E') {
    printf("arg%d invalid board_id", parser->ix);
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
  } else if (strcmp(command, "edparam") == 0) {
    uint16_t pulse_dur_us = parse_int(&parser, 5, 10000);
    uint8_t duty_pct = parse_int(&parser, 1, 50);
    if (!parser.success) {
      return;
    }
    exec_command_edparam(pulse_dur_us, duty_pct, config);
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
    exec_command_drill(md_ix, distance, config);
  } else {
    printf("unknown command\n");
  }
}

int main() {
  // init compute
  stdio_init_all();

  // init I/O
  pico_led_init();
  ed_init(); // in r0, MD noise disrupts ED SENSE_CURR, thus detection of the
             // ED board. Thus, ed must be initialized before MD.
  md_init();

  pico_led_set(true); // I/O init complete
  print_time();

  // init system config
  ctrl_config_t config;
  config.pulse_dur_us = 500;
  config.duty_pct = 50;

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
