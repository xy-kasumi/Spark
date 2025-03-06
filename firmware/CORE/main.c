// SPDX-License-Identifier: AGPL-3.0-or-later
#include "hardware/gpio.h"
#include "pico/stdlib.h"
#include <ctype.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "pulser.h"
#include "stpdrv.h"

////////////////////////////////////////////////////////////////////////////////
// Basic I/O

void pico_led_init() {
  gpio_init(PICO_DEFAULT_LED_PIN);
  gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
}

void pico_led_set(bool on) { gpio_put(PICO_DEFAULT_LED_PIN, on); }

// flash led off for a short time.
void pico_led_flash() {
  const int LED_OFF_TIME_MS = 100;
  pico_led_set(false);
  sleep_ms(LED_OFF_TIME_MS);
  pico_led_set(true);
}

void print_time() {
  int t = to_ms_since_boot(get_absolute_time());
  int t_sec = t / 1000;
  int t_ms = t % 1000;
  printf("%d.%03d ", t_sec, t_ms);
}

////////////////////////////////////////////////////////////////////////////////
// Control loop

// Target value control for ctrl_motor_motion_t.
typedef enum {
  CTRL_POS, // try to stop at target pos.
  CTRL_VEL, // try to reach target vel. don't care about pos.
} ctrl_mode_t;

// Motor's velocity/position controller.
// Main purpose: plan trajectory while satisfying max acc/vel constraints.
// Frequency: CONTROL_LOOP_HZ
typedef struct {
  float curr_vel_mm_per_s;
  float curr_pos_mm;
  ctrl_mode_t mode;
  // target pos (if mode == CTRL_POS) or target vel (if mode == CTRL_VEL)
  float targ_value;
} ctrl_motor_motion_t;

// Plan motor's step sequence to satisfy position requirement.
// Frequency: multiple of CONTROL_LOOP_HZ.
typedef struct {
  int stpdrv_ix;
  int mot_curr_step;
  int remaining_steps;
  int us_between_steps;
} ctrl_motor_step_t;

typedef enum {
  OP_NONE,
  OP_FEED,
  OP_FIND,
} ctrl_op_t;

typedef struct {
  uint64_t tick;
  int stpdrv_ix;
  int max_load_us; // us past in single loop processing

  ctrl_op_t op;
  int targ_igt_us; // op == OP_FEED
  int avg_igt_us;  // op == OP_FEED
  int sd_igt_us;   // op == OP_FEED
  float pos_limit_min;
  float pos_limit_max;

  ctrl_motor_motion_t motor_motion;
  ctrl_motor_step_t motor_step;
} control_t;

void set_target_vel(ctrl_motor_motion_t* ctrl_motion, float targ_vel_mm_per_s) {
  // Limit for safety.
  if (targ_vel_mm_per_s > MAX_SPEED_MM_PER_S) {
    targ_vel_mm_per_s = MAX_SPEED_MM_PER_S;
  } else if (targ_vel_mm_per_s < -MAX_SPEED_MM_PER_S) {
    targ_vel_mm_per_s = -MAX_SPEED_MM_PER_S;
  }

  ctrl_motion->mode = CTRL_VEL;
  ctrl_motion->targ_value = targ_vel_mm_per_s;
}

void set_target_pos(ctrl_motor_motion_t* ctrl_motion, float targ_pos_mm) {
  ctrl_motion->mode = CTRL_POS;
  ctrl_motion->targ_value = targ_pos_mm;
}

static inline float square(float x) { return x * x; }

// Distribute steps evenly in loop interval.
int64_t control_loop_step_motor(alarm_id_t aid, void* data) {
  ctrl_motor_step_t* ctrl_step = data;
  if (ctrl_step->remaining_steps > 0) {
    stpdrv_step(ctrl_step->stpdrv_ix, true);
    ctrl_step->mot_curr_step++;
    ctrl_step->remaining_steps--;
  } else {
    stpdrv_step(ctrl_step->stpdrv_ix, false);
    ctrl_step->mot_curr_step--;
    ctrl_step->remaining_steps++;
  }

  if (ctrl_step->remaining_steps == 0) {
    return 0; // stepping in this loop is done. cancel alarm.
  } else {
    return -ctrl_step->us_between_steps; // keep periodic stepping
  }
}

void tick_motor_motion(ctrl_motor_motion_t* motion) {
  const float MAX_DVEL = MAX_ACC_MM_PER_S2 * CTRL_DT_S;
  const float EPS_VEL = MAX_ACC_MM_PER_S2 * CTRL_DT_S * 2;

  bool pos_override = false;
  if (motion->mode == CTRL_VEL) {
    float vel_targ = motion->targ_value;

    float delta_vel = vel_targ - motion->curr_vel_mm_per_s;
    if (fabsf(delta_vel) <= MAX_DVEL) {
      // already close enough velocity.
      motion->curr_vel_mm_per_s = vel_targ;
    } else {
      // accel or decel at max.
      motion->curr_vel_mm_per_s += copysignf(MAX_DVEL, delta_vel);
    }
  } else if (motion->mode == CTRL_POS) {
    float pos_targ = motion->targ_value;

    float delta_pos = pos_targ - motion->curr_pos_mm;
    if (fabsf(delta_pos) < 1e-3 && fabsf(motion->curr_vel_mm_per_s) < EPS_VEL) {
      // already close enough (pos~targ and vel~0).
      motion->curr_vel_mm_per_s = 0;
      pos_override = true;
      motion->curr_pos_mm = pos_targ;
    } else if ((delta_pos > 0 && motion->curr_vel_mm_per_s < 0) ||
               (delta_pos < 0 && motion->curr_vel_mm_per_s > 0)) {
      // currently going in opossite direction. need to slow down to V=0 first.
      if (delta_pos > 0) {
        motion->curr_vel_mm_per_s =
            fminf(0, motion->curr_vel_mm_per_s + MAX_DVEL);
      } else {
        motion->curr_vel_mm_per_s =
            fmaxf(0, motion->curr_vel_mm_per_s - MAX_DVEL);
      }
    } else {
      // stopped or going towards target.
      // we have 3 choices: cruise, decelerate, accelerate
      float stop_time = fabsf(motion->curr_vel_mm_per_s) / MAX_ACC_MM_PER_S2;
      float stop_dist = 0.5 * MAX_ACC_MM_PER_S2 * square(stop_time);

      float dist_pos = fabsf(delta_pos);
      if (dist_pos <= stop_dist) {
        // decel
        motion->curr_vel_mm_per_s -= copysignf(MAX_DVEL, delta_pos);
      } else {
        if (fabsf(motion->curr_vel_mm_per_s) < MAX_SPEED_MM_PER_S - EPS_VEL) {
          // not max speed yet; we can accelerate to reach faster.
          motion->curr_vel_mm_per_s += copysignf(MAX_DVEL, delta_pos);
        }
      }
    }
  }
  if (!pos_override) {
    motion->curr_pos_mm += motion->curr_vel_mm_per_s * CTRL_DT_S;
  }
}

void tick_motor_step(ctrl_motor_step_t* step, float curr_pos_mm) {
  if (step->remaining_steps != 0) {
    // shouldn't happen.
    // uC is probably overloaded.
    // TODO: display some kind of error
    return; // keep executing previous alarm without adding new alarms.
  }

  int targ_step = roundf(curr_pos_mm * STEPS_PER_MM);
  int delta_step = targ_step - step->mot_curr_step;
  if (delta_step != 0) {
    if (delta_step > MAX_STEP_IN_LOOP) {
      delta_step = MAX_STEP_IN_LOOP;
    } else if (delta_step < -MAX_STEP_IN_LOOP) {
      delta_step = -MAX_STEP_IN_LOOP;
    }
    step->remaining_steps = delta_step;
    step->us_between_steps = CTRL_DT_US / abs(delta_step);
    add_alarm_in_us(0, &control_loop_step_motor, step, true);
  }
}

void tick_feed_control(control_t* control) {
  // TODO: slow loop to control targ_ig. (1 Hz??) maximize avg. pulse duration
  // by optimizing targ_ig.

  // Coefficient that converts: Tig stddev [us] -> Tig allowed range of
  // deviation [us]. Smaller value: possibly faster response, but might lead
  // to oscillation. Larger value: stable, but might be slow.
  const float DEADBAND_PARAM = 2.0;

  // Converts: Tig error [us] -> change in velocity [mm/s], per unit time
  // [mm/s^2].
  const float GAIN = MAX_ACC_MM_PER_S2 / 250;

  int n_pulse;
  int avg_igt_us;
  int sd_igt_us;
  int r_pulse;
  int r_short;
  int r_open;
  pulser_checkpoint_read(&n_pulse, &avg_igt_us, &sd_igt_us, &r_pulse, &r_short,
                         &r_open);
  if (n_pulse > 0) {
    control->avg_igt_us = avg_igt_us;
    control->sd_igt_us = sd_igt_us;
  }

  float allowed_deviation = DEADBAND_PARAM * control->sd_igt_us;
  float error = control->avg_igt_us - control->targ_igt_us;

  if (abs(error) > allowed_deviation) {
    // only change velocity when it's outside of allowed range.
    // Accelerate if Tig is bigger than target, decelerate if Tig is smaller.
    float targ_vel_mm_per_s = control->motor_motion.curr_vel_mm_per_s +
                              error * GAIN * (CTRL_DT_US * 1e-6);
    set_target_vel(&control->motor_motion, targ_vel_mm_per_s);
  }
}

void tick_find_control(control_t* control) {
  int n_pulse;
  int avg_igt_us;
  int sd_igt_us;
  int r_pulse;
  int r_short;
  int r_open;
  pulser_checkpoint_read(&n_pulse, &avg_igt_us, &sd_igt_us, &r_pulse, &r_short,
                         &r_open);
  if (n_pulse > 0 || r_short > 0) {
    // found
    set_target_vel(&control->motor_motion, 0);
    control->op = OP_NONE;
  }
}

// Main control loop at CONTROL_LOOP_HZ.
bool tick_control_loop(repeating_timer_t* rt) {
  absolute_time_t begin_time = get_absolute_time();
  control_t* control = (control_t*)rt->user_data;

  if (control->op == OP_FEED) {
    tick_feed_control(control);
  } else if (control->op == OP_FIND) {
    tick_find_control(control);
  }
  tick_motor_motion(&control->motor_motion);
  if (control->op != OP_NONE) {
    // Stop immediately if we hit the limit.
    if (control->motor_motion.curr_pos_mm <= control->pos_limit_min) {
      control->motor_motion.curr_pos_mm = control->pos_limit_min;
      control->motor_motion.curr_vel_mm_per_s = 0;
      set_target_vel(&control->motor_motion, 0);
      control->op = OP_NONE;
    } else if (control->motor_motion.curr_pos_mm >= control->pos_limit_max) {
      control->motor_motion.curr_pos_mm = control->pos_limit_max;
      control->motor_motion.curr_vel_mm_per_s = 0;
      set_target_vel(&control->motor_motion, 0);
      control->op = OP_NONE;
    }
  }
  tick_motor_step(&control->motor_step, control->motor_motion.curr_pos_mm);

  control->tick++;
  absolute_time_t end_time = get_absolute_time();
  uint64_t load_us = absolute_time_diff_us(begin_time, end_time);
  if (load_us > control->max_load_us) {
    control->max_load_us = load_us;
  }
  return true;
}

void control_start_feed(control_t* control, float targ_pos_mm) {
  control->op = OP_FEED;
  if (targ_pos_mm > control->motor_motion.curr_pos_mm) {
    control->pos_limit_min =
        control->motor_motion.curr_pos_mm - 1; // whatever offset
    control->pos_limit_max = targ_pos_mm;
  } else {
    control->pos_limit_min = targ_pos_mm;
    control->pos_limit_max =
        control->motor_motion.curr_pos_mm + 1; // whatever offset
  }
  control->targ_igt_us = 200;
  control->avg_igt_us = 500; // assume big number
  control->sd_igt_us = 500;  // assume big number
}

void control_start_find(control_t* control, float lim_pos_mm) {
  control->op = OP_FIND;
  if (lim_pos_mm > control->motor_motion.curr_pos_mm) {
    control->pos_limit_min =
        control->motor_motion.curr_pos_mm - 1; // whatever offset
    control->pos_limit_max = lim_pos_mm;
    set_target_vel(&control->motor_motion, FIND_SPEED_MM_PER_S);
  } else {
    control->pos_limit_min = lim_pos_mm;
    control->pos_limit_max =
        control->motor_motion.curr_pos_mm + 1; // whatever offset
    set_target_vel(&control->motor_motion, -FIND_SPEED_MM_PER_S);
  }
}

void control_abort(control_t* control) {
  control->op = OP_NONE;
  set_target_vel(&control->motor_motion, 0);
}

bool control_is_ready(control_t* control) {
  return control->op == OP_NONE && control->motor_motion.curr_vel_mm_per_s == 0;
}

// reason_is_limit is set to true if op is ended because of position limit.
// returns: true if op is ended or hasn't started.
bool control_check_status(control_t* control, bool* reason_is_limit) {
  if (control->op != OP_NONE) {
    return false;
  }

  *reason_is_limit =
      (control->motor_motion.curr_pos_mm <= control->pos_limit_min ||
       control->motor_motion.curr_pos_mm >= control->pos_limit_max);
  return true;
}

void control_loop_init(control_t* control, repeating_timer_t* rt) {
  control->tick = 0;
  control->stpdrv_ix = 0;
  control->max_load_us = 0;
  control->op = OP_NONE;
  control->targ_igt_us = -1;
  control->avg_igt_us = -1;
  control->sd_igt_us = -1;
  control->pos_limit_min = -200;
  control->pos_limit_max = 200;

  control->motor_motion.curr_vel_mm_per_s = 0;
  control->motor_motion.curr_pos_mm = 0;
  control->motor_motion.mode = CTRL_POS;
  control->motor_motion.targ_value = 0;

  control->motor_step.stpdrv_ix = 0;
  control->motor_step.mot_curr_step = 0;
  control->motor_step.remaining_steps = 0;
  control->motor_step.us_between_steps = 0;

  alarm_pool_add_repeating_timer_us(alarm_pool_get_default(), CTRL_DT_US,
                                    &tick_control_loop, control, rt);
}

////////////////////////////////////////////////////////////////////////////////
// Commands

bool abort_requested();

typedef struct {
  control_t control;
  int pulse_dur_us;
  int duty_pct;
  int current_ma;
} app_t;

void exec_command_status(app_t* app) {
  printf("# HARDWARE\n");
  for (int i = 0; i < STPDRV_NUM_BOARDS; i++) {
    stpdrv_board_status_t status = stpdrv_get_status(i);

    printf("STPDRV%d: ", i);
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
  printf("PULSER: %s\n", pulser_state);

  printf("# CONTROL\n");
  printf("pulse: dur=%uus duty=%u%% curr=%umA\n", app->pulse_dur_us,
         app->duty_pct, app->current_ma);

  printf("control: pos=%.2f (step=%d) vel=%.2f (tick=%llu, max_load=%dus)\n",
         app->control.motor_motion.curr_pos_mm,
         app->control.motor_step.mot_curr_step,
         app->control.motor_motion.curr_vel_mm_per_s, app->control.tick,
         app->control.max_load_us);
}

void exec_command_edparam(int pulse_dur_us, int duty_pct, int curr_ma,
                          app_t* app) {
  app->pulse_dur_us = pulse_dur_us;
  app->duty_pct = duty_pct;
  app->current_ma = curr_ma;

  print_time();
  printf("New pulse: dur_us=%u, duty=%u%%, curr_ma=%u\n", app->pulse_dur_us,
         app->duty_pct, app->current_ma);
}

void exec_command_regread(char board_id, int addr) {
  if (board_id == 'E') {
    int value = pulser_read_register(addr);
    printf("board E: reg 0x%02x = 0x%02x (%d)\n", addr, value, value);
  } else {
    int value = stpdrv_read_register(board_id - '0', addr);
    printf("board %c: reg 0x%02x = 0x%08x\n", board_id, addr, value);
  }
}

void exec_command_regwrite(char board_id, int addr, int data) {
  if (board_id == 'E') {
    pulser_write_register(addr, (int)data);
    printf("board E: reg 0x%02x set to 0x%02x\n", addr, (int)data);
  } else {
    stpdrv_write_register(board_id - '0', addr, data);
    printf("board %c: reg 0x%02x set to 0x%08x\n", board_id, addr, data);
  }
}

void exec_command_move(int stpdrv_ix, float distance, app_t* app) {
  if (!control_is_ready(&app->control)) {
    printf("move: not ready\n");
    return;
  }

  float targ_pos = app->control.motor_motion.curr_pos_mm + distance;
  set_target_pos(&app->control.motor_motion, targ_pos);

  while (true) {
    if (abort_requested()) {
      control_abort(&app->control);
      print_time();
      printf("move: ABORTED");
      break;
    }

    if (app->control.motor_motion.curr_pos_mm == targ_pos &&
        app->control.motor_motion.curr_vel_mm_per_s == 0) {
      print_time();
      printf("move: DONE");
      break;
    }
  }
  printf(" (x=%.2f)\n", app->control.motor_motion.curr_pos_mm);
}

void exec_command_find(int stpdrv_ix, float distance, app_t* app) {
  if (!control_is_ready(&app->control)) {
    printf("find: not ready\n");
    return;
  }

  bool is_plus = distance > 0;
  float pos_limit = app->control.motor_motion.curr_pos_mm + distance;

  pulser_set_current(100);
  pulser_set_energize(true);
  pulser_unsafe_set_gate(true);
  control_start_find(&app->control, pos_limit);

  while (true) {
    if (abort_requested()) {
      control_abort(&app->control);
      print_time();
      printf("find: ABORTED");
      break;
    }
    bool reason_is_limit;
    if (control_check_status(&app->control, &reason_is_limit)) {
      print_time();
      if (reason_is_limit) {
        printf("find: DONE (not found)");
      } else {
        printf("find: DONE (found)");
      }
      break;
    }
  }
  printf(" (x=%.2f)\n", app->control.motor_motion.curr_pos_mm);
  pulser_unsafe_set_gate(false);
  pulser_set_energize(false);
}

void exec_command_feed(int stpdrv_ix, float dist_mm, app_t* app) {
  if (dist_mm <= 1e-3) {
    printf("feed: too small feed distance\n");
    return;
  }
  if (!control_is_ready(&app->control)) {
    printf("feed: not ready\n");
    return;
  }

  pulser_set_pulse_dur(app->pulse_dur_us);
  pulser_set_max_duty(app->duty_pct);
  pulser_set_current(app->current_ma);
  pulser_set_energize(true);
  pulser_unsafe_set_gate(true);

  float orig_pos = app->control.motor_motion.curr_pos_mm;
  control_start_feed(&app->control, orig_pos + dist_mm);

  absolute_time_t start_time = get_absolute_time();
  absolute_time_t last_report = start_time;
  while (true) {
    if (abort_requested()) {
      control_abort(&app->control);
      print_time();
      printf("feed: ABORTED");
      break;
    }
    bool reason_is_limit;
    if (control_check_status(&app->control, &reason_is_limit)) {
      print_time();
      printf("feed: DONE");
      break;
    }

    absolute_time_t now = get_absolute_time();
    if (absolute_time_diff_us(last_report, get_absolute_time()) > 1000000) {
      print_time();
      float time_past_s = absolute_time_diff_us(start_time, now) * 1e-6;
      float dp_mm = fabsf(app->control.motor_motion.curr_pos_mm - orig_pos);
      float eff_speed_mm_per_s = time_past_s < 1 ? 0 : dp_mm / time_past_s;
      float progress = dp_mm / dist_mm;
      float progress_speed = time_past_s < 1 ? 0 : progress / time_past_s;
      float eta_s = progress_speed < 1e-6 ? 1e6 : (1 - progress) / progress;
      printf("feed: %.1f%% ETA=%fs speed=%.3fmm/s (dx=%.2f, x=%.2f)\n",
             progress * 100, eta_s, eff_speed_mm_per_s, dp_mm,
             app->control.motor_motion.curr_pos_mm);

      last_report = get_absolute_time();
    }
  }

  printf(" (x=%.2f)\n", app->control.motor_motion.curr_pos_mm);
  pulser_unsafe_set_gate(false);
  pulser_set_energize(false);
}

////////////////////////////////////////////////////////////////////////////////
// Command parser

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

bool abort_requested() {
  int res = stdio_getchar_timeout_us(1);
  if (res == PICO_ERROR_TIMEOUT) {
    return false;
  }
  return (res == 3 || res == 11);
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
int parse_int(parser_t* parser, int min, int max) {
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
int parse_hex(parser_t* parser, int max) {
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
 * @param buf command string, without newlines. will be modified during
 * parsing.
 */
void try_exec_command(char* buf, app_t* app) {
  parser_t parser;
  char* command = parser_init(&parser, buf);

  if (strcmp(command, "status") == 0) {
    exec_command_status(app);
  } else if (strcmp(command, "edparam") == 0) {
    int pulse_dur_us = parse_int(&parser, 5, 10000);
    int duty_pct = parse_int(&parser, 1, 50);
    int curr_ma = parse_int(&parser, 100, 8000);
    if (!parser.success) {
      return;
    }
    exec_command_edparam(pulse_dur_us, duty_pct, curr_ma, app);
  } else if (strcmp(command, "move") == 0) {
    int stpdrv_ix = parse_int(&parser, 0, STPDRV_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_move(stpdrv_ix, distance, app);
  } else if (strcmp(command, "find") == 0) {
    int stpdrv_ix = parse_int(&parser, 0, STPDRV_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_find(stpdrv_ix, distance, app);
  } else if (strcmp(command, "feed") == 0) {
    int stpdrv_ix = parse_int(&parser, 0, STPDRV_NUM_BOARDS - 1);
    float distance = parse_float(&parser);
    if (!parser.success) {
      return;
    }
    exec_command_feed(stpdrv_ix, distance, app);
  } else if (strcmp(command, "regread") == 0) {
    char board_id = parse_board_id(&parser);
    int addr = parse_hex(&parser, 0x7f);
    if (!parser.success) {
      return;
    }
    exec_command_regread(board_id, addr);
  } else if (strcmp(command, "regwrite") == 0) {
    char board_id = parse_board_id(&parser);
    int addr = parse_hex(&parser, 0x7f);
    int data = parse_hex(&parser, 0xffffffff);
    if (!parser.success) {
      return;
    }
    exec_command_regwrite(board_id, addr, data);
  } else {
    printf("unknown command\n");
  }
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

  // init system app
  app_t app;
  app.pulse_dur_us = 500;
  app.duty_pct = 50;
  app.current_ma = 1000;

  // start control loop
  repeating_timer_t rt;
  control_loop_init(&app.control, &rt);

  // report init done
  printf("init OK\n");
  exec_command_status(&app);

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
    try_exec_command(buf, &app);
  }
}
