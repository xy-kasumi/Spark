#include <stdio.h>
#include "hardware/gpio.h"
#include "pico/stdlib.h"

#include "config.h"
#include "md.h"

int pico_led_init(void) {
  gpio_init(PICO_DEFAULT_LED_PIN);
  gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
  return PICO_OK;
}

void pico_set_led(bool led_on) {
  gpio_put(PICO_DEFAULT_LED_PIN, led_on);
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

int main() {
  stdio_init_all();

  md_init();
  ed_init();

  int rc = pico_led_init();
  hard_assert(rc == PICO_OK);
  while (true) {
    pico_set_led(true);
    sleep_ms(LED_FLASH_MS);
    pico_set_led(false);
    sleep_ms(LED_INTERVAL_MS - LED_FLASH_MS);

    printf("Hello, world!\n");
  }
}
