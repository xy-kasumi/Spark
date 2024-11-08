#include "md.h"

#include "hardware/gpio.h"
#include "hardware/spi.h"
#include "pico/stdlib.h"

#include "config.h"

static const uint8_t REG_GCONF = 0x00;
static const uint8_t REG_GSTAT = 0x01;
static const uint8_t REG_CHOPCONF = 0x6c;
static const uint8_t REG_DRV_STATUS = 0x6f;

md_board_status_t boards[MD_NUM_BOARDS];

void md_bus_init() {
  // 3 MHz is 75% of 4 MHz max, specified in TMC2130 datasheet "SCK frequency
  // using internal clock"
  const uint MD_SPI_BAUDRATE = 3 * 1000 * 1000;

  // SPI pins. Keep CSN pins high (select no chip).
  gpio_init(CTRL_MD_SCK);
  gpio_set_function(CTRL_MD_SCK, GPIO_FUNC_SPI);
  gpio_init(CTRL_MD_SDI);
  gpio_set_function(CTRL_MD_SDI, GPIO_FUNC_SPI);
  gpio_init(CTRL_MD_SDO);
  gpio_set_function(CTRL_MD_SDO, GPIO_FUNC_SPI);

  gpio_init(CTRL_MD_CSN0_PIN);
  gpio_init(CTRL_MD_CSN1_PIN);
  gpio_init(CTRL_MD_CSN2_PIN);

  gpio_put(CTRL_MD_CSN0_PIN, true);
  gpio_put(CTRL_MD_CSN1_PIN, true);
  gpio_put(CTRL_MD_CSN2_PIN, true);

  // STEP/DIR pins
  gpio_init(CTRL_MD_DIR_PIN);
  gpio_put(CTRL_MD_DIR_PIN, false);
  gpio_init(CTRL_MD_STEP0_PIN);
  gpio_put(CTRL_MD_STEP0_PIN, false);
  gpio_init(CTRL_MD_STEP1_PIN);
  gpio_put(CTRL_MD_STEP1_PIN, false);
  gpio_init(CTRL_MD_STEP2_PIN);
  gpio_put(CTRL_MD_STEP2_PIN, false);

  // SPI peripheral
  spi_init(MD_SPI, MD_SPI_BAUDRATE);
  spi_set_slave(MD_SPI, false);
  spi_set_format(MD_SPI, 8, SPI_CPOL_1, SPI_CPHA_0, SPI_MSB_FIRST);
}

/**
 * Send a single 40-bit datagram to a motor driver board (TMC2130).
 * This is a low-level function as specified in datasheet.
 * e.g. result returns result from the previous read.
 *
 * md_index: selects board. must be 0, 1, or 2.
 * data, result: both are big-endian (MSB is sent/received first).
 *
 * returns: true if success. false if SPI communication failed unexpectedly
 * (board unconnected, invalid address, malfunctioning).
 */
bool md_send_datagram_blocking(uint8_t md_index,
                               uint8_t addr,
                               bool write,
                               uint32_t data,
                               uint32_t* result) {
  // validate
  if (addr >= 0x80) {
    return false;  // invalid address
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
      return false;  // non-existent board
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
  int count = spi_write_read_blocking(MD_SPI, tx_data, rx_data, 5);

  // result check
  if (count != 5) {
    return false;  // data length mismatch
  }
  *result = 0;
  *result |= ((uint32_t)rx_data[1]) << 24;
  *result |= ((uint32_t)rx_data[2]) << 16;
  *result |= ((uint32_t)rx_data[3]) << 8;
  *result |= ((uint32_t)rx_data[4]);

  return true;
}

// returns true if register read was successful
bool read_register(uint8_t md_index, uint8_t addr, uint32_t* result) {
  // Prepare read.
  uint32_t dummy;
  if (!md_send_datagram_blocking(md_index, addr, false, 0, &dummy)) {
    return false;
  }

  // Read out previous register value using fake register
  // GCONF is good because it's RW register. we can't use R+C register like
  // GSTAT, because double-read will erase data unexpectedly.
  if (!md_send_datagram_blocking(md_index, REG_GCONF, false, 0, result)) {
    return false;
  }
  return true;
}

bool write_register(uint8_t md_index, uint8_t addr, uint32_t data) {
  uint32_t dummy;
  return md_send_datagram_blocking(md_index, addr, true, data, &dummy);
}

/**
 * Initialize SPI/GPIO pins and scans board, configures them to vense=1 (high
 * sensitivity) and 256 microstep. After this, boards[] will be populated with
 * status.
 */
void md_init() {
  md_bus_init();

  for (uint8_t i = 0; i < MD_NUM_BOARDS; i++) {
    boards[i] = MD_NO_BOARD;

    // check if motor is connected.
    uint32_t drv_status;
    if (!read_register(i, REG_DRV_STATUS, &drv_status)) {
      continue;
    }
    bool olb = drv_status & (1 << 30) != 0;
    bool ola = drv_status & (1 << 29) != 0;
    if (olb || ola) {
      boards[i] = MD_NO_MOTOR;
      continue;
    }

    // configure current sense.
    uint32_t chopconf;
    if (!read_register(i, REG_CHOPCONF, &chopconf)) {
      continue;
    }
    chopconf |= (1 << 17);  // vsense = 1 (high sensitivity)
    if (!write_register(i, REG_CHOPCONF, chopconf)) {
      continue;
    }

    boards[i] = MD_OK;
  }
}

md_board_status_t md_get_status(uint8_t md_index) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return MD_NO_BOARD;
  }
  if (boards[md_index] != MD_OK) {
    return boards[md_index];
  }

  uint32_t result;
  if (read_register(md_index, REG_GSTAT, &result)) {
    // OVERTEMP (0b010) or UNDERVOLTAGE (0b100)
    if (result & 0b110 != 0) {
      boards[md_index] = MD_OVERTEMP;
    }
  } else {
    boards[md_index] = MD_SPI_ERROR;
  }

  return boards[md_index];
}

void md_step(uint8_t md_index, bool plus) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return;
  }
  if (boards[md_index] != MD_OK) {
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

  gpio_put(gpio_step_pin, false);
  wait_100ns();  // wait tSL ~ 100ns
}

bool check_stall(uint8_t md_index) {
  if (md_index > MD_NUM_BOARDS - 1) {
    return false;
  }
  if (boards[md_index] != MD_OK) {
    return false;
  }

  uint32_t result;
  if (!read_register(md_index, REG_DRV_STATUS, &result)) {
    boards[md_index] = MD_SPI_ERROR;
    return false;
  }

  return result & (1 << 24) != 0;  // StallGuard
}
