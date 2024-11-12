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

    printf("board %d: ", i);
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

// supported commands
// ------------------
// each line should contain single command
//
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
// Ctrl-C or Ctrl-K during input
//   cancel current command input

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

bool parse_board_ix(const char* board_ix_str, uint8_t* md_ix) {
  if (board_ix_str == NULL) {
    printf("missing board index\n");
    return false;
  }

  char* end;
  uint8_t res = strtol(board_ix_str, &end, 10);
  if (board_ix_str == end || *end != 0 || *md_ix < 0 ||
      *md_ix >= MD_NUM_BOARDS) {
    printf("invalid board index\n");
    return false;
  }
  *md_ix = res;
  return true;
}

bool parse_int(const char* str, int* val) {
  if (str == NULL) {
    printf("missing int\n");
    return false;
  }

  char* end;
  int res = strtol(str, &end, 10);
  if (str == end || *end != 0) {
    printf("invalid int\n");
    return false;
  }
  *val = res;
  return true;
}

bool parse_positive_int(const char* str, uint32_t* val) {
  if (str == NULL) {
    printf("missing positive int\n");
    return false;
  }

  char* end;
  int res = strtol(str, &end, 10);
  if (str == end || *end != 0 || res <= 0) {
    printf("invalid positive integer\n");
    return false;
  }
  *val = res;
  return true;
}

bool parse_hex(const char* str, uint32_t* val) {
  if (str == NULL) {
    printf("missing hex\n");
    return false;
  }

  char* end;
  int res = strtol(str, &end, 16);
  if (str == end || *end != 0) {
    printf("invalid hex\n");
    return false;
  }
  *val = res;
  return true;
}

bool parse_dir(const char* str, bool* dir_plus) {
  if (str == NULL) {
    printf("missing direction\n");
    return false;
  }

  if (strcmp(str, "-") == 0) {
    *dir_plus = false;
    return true;
  } else if (strcmp(str, "+") == 0) {
    *dir_plus = true;
    return true;
  } else {
    printf("invalid direction\n");
    return false;
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
    bool success = stdio_getline(buf, sizeof(buf));
    printf("\n");
    print_time();

    if (!success) {
      printf("command canceled\n");
      continue;
    }
    printf("processing command\n");
    pico_led_flash();

    char* command = strtok(buf, " ");

    if (strcmp(command, "status") == 0) {
      exec_command_status();
    } else if (strcmp(command, "step") == 0) {
      char* board_ix_str = strtok(NULL, " ");
      char* step_str = strtok(NULL, " ");
      char* wait_str = strtok(NULL, " ");

      uint8_t md_ix;
      if (!parse_board_ix(board_ix_str, &md_ix)) {
        continue;
      }
      int step;
      if (!parse_int(step_str, &step)) {
        continue;
      }
      uint32_t wait;
      if (!parse_positive_int(wait_str, &wait)) {
        continue;
      }

      exec_command_step(md_ix, step, wait);
    } else if (strcmp(command, "home") == 0) {
      char* board_ix_str = strtok(NULL, " ");
      char* direction_str = strtok(NULL, " ");
      char* timeout_str = strtok(NULL, " ");

      uint8_t md_ix;
      if (!parse_board_ix(board_ix_str, &md_ix)) {
        continue;
      }
      bool dir_plus;
      if (!parse_dir(direction_str, &dir_plus)) {
        continue;
      }
      int timeout_ms;
      if (!parse_int(timeout_str, &timeout_ms)) {
        continue;
      }

      exec_command_home(md_ix, dir_plus, timeout_ms);
    } else if (strcmp(command, "regread") == 0) {
      char* board_ix_str = strtok(NULL, " ");
      char* addr_str = strtok(NULL, " ");

      uint8_t md_ix;
      if (!parse_board_ix(board_ix_str, &md_ix)) {
        continue;
      }
      uint32_t addr;
      if (!parse_hex(addr_str, &addr)) {
        continue;
      }

      exec_command_regread(md_ix, addr);
    } else if (strcmp(command, "regwrite") == 0) {
      char* board_ix_str = strtok(NULL, " ");
      char* addr_str = strtok(NULL, " ");
      char* data_str = strtok(NULL, " ");

      uint8_t md_ix;
      if (!parse_board_ix(board_ix_str, &md_ix)) {
        continue;
      }
      uint32_t addr;
      if (!parse_hex(addr_str, &addr)) {
        continue;
      }
      uint32_t data;
      if (!parse_hex(data_str, &data)) {
        continue;
      }

      exec_command_regwrite(md_ix, addr, data);
    } else {
      printf("unknown command\n");
    }
  }
}
