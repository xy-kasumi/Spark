#include "md.h"

#include "hardware/gpio.h"
#include "hardware/spi.h"
#include "pico/stdlib.h"

#include "config.h"

static const uint8_t REG_GCONF = 0x00;
static const uint8_t REG_GSTAT = 0x01;
static const uint8_t REG_IOIN = 0x04;
static const uint8_t REG_IHOLD_IRUN = 0x10;
static const uint8_t REG_CHOPCONF = 0x6c;
static const uint8_t REG_COOLCONF = 0x6d;
static const uint8_t REG_DRV_STATUS = 0x6f;

void md_bus_init() {
  // 3 MHz is 75% of 4 MHz max, specified in TMC2130 datasheet "SCK frequency
  // using internal clock"
  const uint MD_SPI_BAUDRATE = 3 * 1000 * 1000;

  // SPI pins. Keep CSN pins high (select no chip).
  uint32_t spi_mask =
      (1 << CTRL_MD_SCK) | (1 << CTRL_MD_SDI) | (1 << CTRL_MD_SDO);
  gpio_init_mask(spi_mask);
  gpio_set_function_masked(spi_mask, GPIO_FUNC_SPI);

  uint32_t csn_mask = (1 << CTRL_MD_CSN0_PIN) | (1 << CTRL_MD_CSN1_PIN) |
                      (1 << CTRL_MD_CSN2_PIN);
  gpio_init_mask(csn_mask);
  gpio_set_dir_masked(csn_mask, 0xffffffff);
  gpio_put_masked(csn_mask, 0xffffffff);

  // STEP/DIR pins
  uint32_t step_dir_mask = (1 << CTRL_MD_DIR_PIN) | (1 << CTRL_MD_STEP0_PIN) |
                           (1 << CTRL_MD_STEP1_PIN) | (1 << CTRL_MD_STEP2_PIN);
  gpio_init_mask(step_dir_mask);
  gpio_set_dir_masked(step_dir_mask, 0xffffffff);
  gpio_put_masked(step_dir_mask, 0);

  // SPI peripheral
  spi_init(MD_SPI, MD_SPI_BAUDRATE);
  spi_set_slave(MD_SPI, false);
  // CPOL1: CLK is high in idle.
  // CPHA1: sample data at CLK rising edge.
  spi_set_format(MD_SPI, 8, SPI_CPOL_1, SPI_CPHA_1, SPI_MSB_FIRST);
}

/**
 * Send a single 40-bit datagram to a motor driver board (TMC2130).
 * This is a low-level function as specified in datasheet.
 * e.g. result returns result from the previous read.
 *
 * md_index: selects board. must be 0, 1, or 2.
 * data, result: both are big-endian (MSB is sent/received first).
 */
void md_send_datagram_blocking(uint8_t md_index,
                               uint8_t addr,
                               bool write,
                               uint32_t data,
                               uint32_t* result) {
  // validate
  if (addr >= 0x80) {
    return;  // invalid address
  }
  int gpio_csn;
  switch (md_index) {
    case 0:
      gpio_csn = CTRL_MD_CSN0_PIN;
      break;
    case 1:
      gpio_csn = CTRL_MD_CSN1_PIN;
      break;
    case 2:
      gpio_csn = CTRL_MD_CSN2_PIN;
      break;
    default:
      return;  // non-existent board
  }

  // packet formation
  uint8_t tx_data[5] = {0x00, 0x00, 0x00, 0x00, 0x00};
  uint8_t rx_data[5] = {0x00, 0x00, 0x00, 0x00, 0x00};

  tx_data[0] = addr | (write ? 0x80 : 0x00);
  if (write) {
    tx_data[1] = (data >> 24) & 0xFF;
    tx_data[2] = (data >> 16) & 0xFF;
    tx_data[3] = (data >> 8) & 0xFF;
    tx_data[4] = data & 0xFF;
  }

  // send/receive
  gpio_put(gpio_csn, false);
  wait_100ns();
  spi_write_read_blocking(MD_SPI, tx_data, rx_data, 5);
  wait_100ns();
  gpio_put(gpio_csn, true);
  wait_100ns();

  // result check
  *result = 0;
  *result |= ((uint32_t)rx_data[1]) << 24;
  *result |= ((uint32_t)rx_data[2]) << 16;
  *result |= ((uint32_t)rx_data[3]) << 8;
  *result |= ((uint32_t)rx_data[4]);
}

uint32_t read_register(uint8_t md_index, uint8_t addr) {
  // Prepare read.
  uint32_t dummy;
  md_send_datagram_blocking(md_index, addr, false, 0, &dummy);

  // Read out previous register value using fake register
  // GCONF is good because it's RW register. we can't use R+C register like
  // GSTAT, because double-read will erase data unexpectedly.
  uint32_t result;
  md_send_datagram_blocking(md_index, REG_GCONF, false, 0, &result);

  return result;
}

void write_register(uint8_t md_index, uint8_t addr, uint32_t data) {
  uint32_t dummy;
  md_send_datagram_blocking(md_index, addr, true, data, &dummy);
}

/**
 * Initialize SPI/GPIO pins and scans board, configures them to vense=1 (high
 * sensitivity) and 256 microstep. After this, boards[] will be populated with
 * status.
 */
void md_init() {
  md_bus_init();

  for (uint8_t i = 0; i < MD_NUM_BOARDS; i++) {
    // check chip version. since this is non-zero value, it can also reject no
    // board or SPI physical error.
    uint32_t ioin = read_register(i, REG_IOIN);
    if ((ioin >> 24) != 0x11) {
      continue;
    }

    // configure current sense.
    uint32_t chopconf = read_register(i, REG_CHOPCONF);
    chopconf |= (1 << 17);  // vsense = 1 (high sensitivity)
    write_register(i, REG_CHOPCONF, chopconf);

    // configure current.
    const uint32_t irun = 20;       // 0~31. 31 is max current.
    const uint32_t ihold = irun;    // same as irun, to prevent weird shift
    const uint32_t iholddelay = 1;  // about 250ms from irun to ihold.
    uint32_t ihold_irun =
        (iholddelay & 0xf) << 16 | (irun & 0x1f) << 8 | (ihold & 0x1f);
    write_register(i, REG_IHOLD_IRUN, ihold_irun);

    // configure stallguard threshold.
    int32_t thresh =
        35;  // must be between -64 ~ 63. Need to be configured such that
             // md_check_stall() returns true when motor is stalled.
    write_register(i, REG_COOLCONF, (thresh & 0x7f) << 16);
  }
}

md_board_status_t md_get_status(uint8_t md_index) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return MD_NO_BOARD;
  }

  // check chip version.
  uint32_t ioin = read_register(md_index, REG_IOIN);
  if ((ioin >> 24) != 0x11) {
    return MD_NO_BOARD;
  }

  uint32_t gstat = read_register(md_index, REG_GSTAT);
  // OVERTEMP (0b010) or UNDERVOLTAGE (0b100)
  if ((gstat & 0b110) != 0) {
    return MD_OVERTEMP;
  }

  return MD_OK;
}

void md_step(uint8_t md_index, bool plus) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return;
  }

  int gpio_step_pin;
  switch (md_index) {
    case 0:
      gpio_step_pin = CTRL_MD_STEP0_PIN;
      break;
    case 1:
      gpio_step_pin = CTRL_MD_STEP1_PIN;
      break;
    case 2:
      gpio_step_pin = CTRL_MD_STEP2_PIN;
      break;
    default:
      return;
  }

  gpio_put(CTRL_MD_DIR_PIN, !plus);
  wait_25ns();  // wait tDSU = 20ns

  gpio_put(gpio_step_pin, true);  // rising edge triggers step
  wait_100ns();                   // wait tSH ~ 100ns
  wait_100ns();

  gpio_put(gpio_step_pin, false);
  wait_100ns();  // wait tSL ~ 100ns
}

bool md_check_stall(uint8_t md_index) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return false;
  }

  uint32_t drv_status = read_register(md_index, REG_DRV_STATUS);
  return (drv_status & (1 << 24)) != 0;  // StallGuard
}

uint32_t md_read_register(uint8_t md_index, uint8_t addr) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return 0;
  }
  if (addr >= 0x80) {
    return 0;
  }

  return read_register(md_index, addr);
}

void md_write_register(uint8_t md_index, uint8_t addr, uint32_t data) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return;
  }
  if (addr >= 0x80) {
    return;
  }

  write_register(md_index, addr, data);
}
