// SPDX-License-Identifier: AGPL-3.0-or-later
#include "md.h"

#include "hardware/gpio.h"
#include "hardware/spi.h"
#include "pico/stdlib.h"

#include "config.h"

// Analog Devices TMC2130 registers
// Add as needed. https://www.analog.com/media/en/technical-documentation/data-sheets/tmc2130_datasheet_rev1.15.pdf
static const uint8_t REG_GCONF = 0x00;
static const uint8_t REG_GSTAT = 0x01;
static const uint8_t REG_IOIN = 0x04;
static const uint8_t REG_IHOLD_IRUN = 0x10;
static const uint8_t REG_CHOPCONF = 0x6c;
static const uint8_t REG_COOLCONF = 0x6d;
static const uint8_t REG_DRV_STATUS = 0x6f;

static const uint32_t GSTAT_DRV_ERR = 1;
static const uint32_t GSTAT_UV_CP = 2;

static const uint32_t IOIN_VERSION_LSB = 24;
static const uint32_t IOIN_VERSION_MASK = 0xff000000;
static const uint32_t IOIN_VERSION_VALUE = 0x11;

static const uint32_t IHOLD_IRUN_IHOLD_LSB = 0;
static const uint32_t IHOLD_IRUN_IHOLD_MASK = 0x0000001f;
static const uint32_t IHOLD_IRUN_IRUN_LSB = 8;
static const uint32_t IHOLD_IRUN_IRUN_MASK = 0x00001f00;
static const uint32_t IHOLD_IRUN_IHOLDDELAY_LSB = 16;
static const uint32_t IHOLD_IRUN_IHOLDDELAY_MASK = 0x000f0000;

static const uint32_t CHOPCONF_MRES_LSB = 24;
static const uint32_t CHOPCONF_MRES_MASK = 0x0f000000;
static const uint32_t CHOPCONF_VSENSE = 17;
static const uint32_t CHOPCONF_HEND_LSB = 7;
static const uint32_t CHOPCONF_HEND_MASK = 0x00000780;
static const uint32_t CHOPCONF_HSTRT_LSB = 4;
static const uint32_t CHOPCONF_HSTRT_MASK = 0x00000070;
static const uint32_t CHOPCONF_TOFF_LSB = 0;
static const uint32_t CHOPCONF_TOFF_MASK = 0x0000000f;

static const uint32_t COOLCONF_SGT_LSB = 16;
static const uint32_t COOLCONF_SGT_MASK = 0x007f0000;

void md_bus_init() {
  // 3 MHz is 75% of 4 MHz max, specified in TMC2130 datasheet "SCK frequency
  // using internal clock"
  const uint MD_SPI_BAUDRATE = 3 * 1000 * 1000;

  // SPI pins. Keep CSN pins high (select no chip).
  uint32_t spi_mask = (1 << PIN_MD_SCK) | (1 << PIN_MD_SDI) | (1 << PIN_MD_SDO);
  gpio_init_mask(spi_mask);
  gpio_set_function_masked(spi_mask, GPIO_FUNC_SPI);

  uint32_t csn_mask =
      (1 << PIN_MD_CSN0) | (1 << PIN_MD_CSN1) | (1 << PIN_MD_CSN2);
  gpio_init_mask(csn_mask);
  gpio_set_dir_masked(csn_mask, 0xffffffff);
  gpio_put_masked(csn_mask, 0xffffffff);

  // STEP/DIR pins
  uint32_t step_dir_mask = (1 << PIN_MD_DIR) | (1 << PIN_MD_STEP0) |
                           (1 << PIN_MD_STEP1) | (1 << PIN_MD_STEP2);
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
void md_send_datagram_blocking(uint8_t md_index, uint8_t addr, bool write,
                               uint32_t data, uint32_t* result) {
  // validate
  if (addr >= 0x80) {
    return; // invalid address
  }
  int gpio_csn;
  switch (md_index) {
  case 0:
    gpio_csn = PIN_MD_CSN0;
    break;
  case 1:
    gpio_csn = PIN_MD_CSN1;
    break;
  case 2:
    gpio_csn = PIN_MD_CSN2;
    break;
  default:
    return; // non-existent board
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
    if ((ioin & IOIN_VERSION_MASK) >> IOIN_VERSION_LSB != IOIN_VERSION_VALUE) {
      continue;
    }

    // configure current sense.
    // Calculate microstep resolution value (mres) based on MD_MICROSTEP
    // mres [0-8]: 0:256, 1:128, 2:64, 3:32, 4:16, 5:8, 6:4, 7:2, 8:1 microsteps
    uint32_t mres;
    if (MD_MICROSTEP >= 1 && MD_MICROSTEP <= 256 &&
        (MD_MICROSTEP & (MD_MICROSTEP - 1)) == 0) {
      mres = 8 - __builtin_ctz(MD_MICROSTEP);
    } else {
      continue; // error; skip this board
    }
    uint32_t chopconf = 0;
    chopconf |= (1 << CHOPCONF_VSENSE); // high sensitivity
    chopconf |= (mres << CHOPCONF_MRES_LSB) & CHOPCONF_MRES_MASK;
    chopconf |= (4 << CHOPCONF_TOFF_LSB) & CHOPCONF_TOFF_MASK;
    chopconf |= (4 << CHOPCONF_HSTRT_LSB) & CHOPCONF_HSTRT_MASK;
    chopconf |= (0 << CHOPCONF_HEND_LSB) & CHOPCONF_HEND_MASK;
    write_register(i, REG_CHOPCONF, chopconf);

    // configure current.
    const uint32_t irun = 20;
    const uint32_t ihold = irun;   // same as irun, to prevent weird shift
    const uint32_t iholddelay = 1; // about 250ms from irun to ihold.
    uint32_t ihold_irun =
        (iholddelay << IHOLD_IRUN_IHOLDDELAY_LSB) & IHOLD_IRUN_IHOLDDELAY_MASK |
        (irun << IHOLD_IRUN_IRUN_LSB) & IHOLD_IRUN_IRUN_MASK |
        (ihold << IHOLD_IRUN_IHOLD_LSB) & IHOLD_IRUN_IHOLD_MASK;
    write_register(i, REG_IHOLD_IRUN, ihold_irun);

    // configure stallguard threshold.
    int32_t thresh = 35; // must be between -64 ~ 63. Need to be configured
                         // such that md_check_stall() returns true when motor
                         // is stalled. Use 7 or 8 for 12V driving stage.
    write_register(i, REG_COOLCONF,
                   (thresh << COOLCONF_SGT_LSB) & COOLCONF_SGT_MASK);
  }
}

md_board_status_t md_get_status(uint8_t md_index) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return MD_NO_BOARD;
  }

  // check chip version.
  uint32_t ioin = read_register(md_index, REG_IOIN);
  if ((ioin & IOIN_VERSION_MASK) >> IOIN_VERSION_LSB != IOIN_VERSION_VALUE) {
    return MD_NO_BOARD;
  }

  uint32_t gstat = read_register(md_index, REG_GSTAT);
  if (gstat & (1 << GSTAT_DRV_ERR) || gstat & (1 << GSTAT_UV_CP)) {
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
    gpio_step_pin = PIN_MD_STEP0;
    break;
  case 1:
    gpio_step_pin = PIN_MD_STEP1;
    break;
  case 2:
    gpio_step_pin = PIN_MD_STEP2;
    break;
  default:
    return;
  }

  gpio_put(PIN_MD_DIR, !plus);
  wait_25ns(); // wait tDSU = 20ns

  gpio_put(gpio_step_pin, true); // rising edge triggers step
  wait_100ns();                  // wait tSH ~ 100ns
  wait_100ns();

  gpio_put(gpio_step_pin, false);
  wait_100ns(); // wait tSL ~ 100ns
}

bool md_check_stall(uint8_t md_index) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return false;
  }

  uint32_t drv_status = read_register(md_index, REG_DRV_STATUS);
  return (drv_status & (1 << 24)) != 0; // StallGuard
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
