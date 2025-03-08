// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * XMODEM/SUM protocol sender implementation.
 *
 * Uses stdio_getchar_timeout_us, stdio_putchar_raw for I/O.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define XMODEM_BLOCK_SIZE 128
#define XMODEM_TIMEOUT_US 100000

typedef enum {
  XMODEM_ERR_NONE,
  XMODEM_ERR_NACK,
  XMODEM_ERR_CAN,
  XMODEM_ERR_TIMEOUT,
  XMODEM_ERR_END_NOT_ACK,
  XMODEM_ERR_END_TIMEOUT,
} xmodem_err_t;

typedef struct {
  bool active;
  xmodem_err_t error;
  uint8_t block_num;

  uint8_t buffer[XMODEM_BLOCK_SIZE];
  size_t buffer_ix;
} xmodem_t;

/**
 * Initiate XMODEM/SUM transmission.
 * Call this after initial NACK from host is consumed.
 */
void xmodem_init(xmodem_t* xmodem);

/**
 * Send text data. You can call this multiple times between xmodem_init and
 * xmodem_finish.
 */
void xmodem_send_text(xmodem_t* xmodem, const char* text);

/**
 * Finish XMODEM transfer.
 * If there's incomplete block, it will be padded by the padding.
 * @returns true if data was successfully sent, false otherwise.
 *          False means transmission error or cancellation.
 */
bool xmodem_finish(xmodem_t* xmodem, uint8_t padding);
