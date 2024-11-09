#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "hardware/gpio.h"
#include "pico/stdlib.h"

#include "config.h"
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

void ed_init() {
  gpio_init(CTRL_ED_MODE_PIN);
  gpio_put(CTRL_ED_MODE_PIN, false);  // false = SENSE mode

  // gpio_init(CTRL_ED_SENSE_GATE_PIN);  // PWM?

  // gpio_init(CTRL_ED_SENSE_CURR_PIN);  // SIO? PWM? ADC?

  /*
  const uint8_t CTRL_ED_DCHG_TARG_PWM_PIN = 7;
  const uint8_t CTRL_ED_DCHG_GATE_PIN = 8;
  const uint8_t CTRL_ED_DCHG_DETECT = 9;
  */
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
    printf("board %d: ", i);
    switch (status) {
      case MD_OK:
        printf("OK");
        break;
      case MD_NO_BOARD:
        printf("NO_BOARD");
        break;
      case MD_NO_MOTOR:
        printf("NO_MOTOR");
        break;
      case MD_OVERTEMP:
        printf("OVERTEMP");
        break;
      case MD_SPI_ERROR:
        printf("SPI_ERROR");
        break;
    }
    printf("\n");
  }
}

void exec_command_step(uint8_t md_ix, int step, int wait) {
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
      20;  // about 1 rotation/sec, assuming 1.8deg/step & 256 microstep.

  absolute_time_t t0 = get_absolute_time();
  while (true) {
    absolute_time_t t1 = get_absolute_time();
    int64_t elapsed_us = absolute_time_diff_us(t0, t1);
    if (elapsed_us >= timeout_us) {
      print_time();
      printf("home: TIMEOUT\n");
      return;
    }

    md_step(md_ix, dir_plus);
  }
  print_time();
  printf("home: DONE\n");
}

// supported commands
// ------------------
// status
//   print status of all boards
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

// trim spaces at the end
void strtrimr(char* str) {
  int n = strlen(str);
  for (int i = n - 1; i >= 0; i--) {
    if (isspace(str[i])) {
      str[i] = '\0';
    } else {
      break;
    }
  }
}

void stdio_getline(char* buf, size_t buf_size) {
  int ix = 0;
  while (ix < buf_size - 1) {
    char ch = stdio_getchar();
    if (ch == '\n' || ch == '\r') {
      buf[ix] = 0;
      break;
    } else {
      buf[ix] = ch;
      ix++;
    }
  }
}

int main() {
  // init compute
  stdio_init_all();

  // init I/O
  pico_led_init();
  md_init();
  ed_init();

  pico_led_set(true);  // I/O init complete
  print_time();
  printf("init OK\n");
  exec_command_status();

  // main command loop
  char buf[32];
  while (true) {
    stdio_getline(buf, sizeof(buf));
    print_time();
    printf("processing command\n");
    pico_led_flash();

    char* command = strtok(buf, " ");

    if (strcmp(command, "status") == 0) {
      exec_command_status();
    } else if (strcmp(command, "step") == 0) {
      char* board_ix_str = strtok(NULL, " ");
      char* step_str = strtok(NULL, " ");
      char* wait_str = strtok(NULL, " ");

      if (board_ix_str == NULL || step_str == NULL || wait_str == NULL) {
        printf("invalid arguments\n");
        continue;
      }

      int md_ix = atoi(board_ix_str);
      int step = atoi(step_str);
      int wait = atoi(wait_str);

      if (md_ix < 0 || md_ix >= MD_NUM_BOARDS) {
        printf("invalid board index\n");
        continue;
      }

      if (wait <= 0) {
        printf("invalid wait time\n");
        continue;
      }
      exec_command_step(md_ix, step, wait);
    } else if (strcmp(command, "home") == 0) {
      char* board_ix_str = strtok(NULL, " ");
      char* direction_str = strtok(NULL, " ");
      char* timeout_str = strtok(NULL, " ");

      if (board_ix_str == NULL || direction_str == NULL ||
          timeout_str == NULL) {
        printf("invalid arguments\n");
        continue;
      }

      int md_ix = atoi(board_ix_str);
      if (md_ix < 0 || md_ix >= MD_NUM_BOARDS) {
        printf("invalid board index\n");
        continue;
      }

      if (strcmp(direction_str, "-") != 0 && strcmp(direction_str, "+") != 0) {
        printf("invalid direction\n");
        continue;
      }

      bool dir_plus = strcmp(direction_str, "+") == 0;
      int timeout_ms = atoi(timeout_str);

      exec_command_home(md_ix, dir_plus, timeout_ms);
    } else {
      printf("unknown command\n");
    }
  }
}
