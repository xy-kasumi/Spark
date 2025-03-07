// SPDX-License-Identifier: AGPL-3.0-or-later
#include "xmodem.h"

#include "pico/stdlib.h"
#include <stdio.h>
#include <string.h>

// XMODEM control characters
#define SOH 0x01
#define EOT 0x04
#define ACK 0x06
#define NAK 0x15
#define CAN 0x18

static void send_block(xmodem_t* xmodem) {
  // Send header
  stdio_putchar_raw(SOH);
  stdio_putchar_raw(xmodem->block_num);
  stdio_putchar_raw(255 - xmodem->block_num);

  // Send data and checksum
  uint8_t checksum = 0;
  for (size_t i = 0; i < XMODEM_BLOCK_SIZE; i++) {
    stdio_putchar_raw(xmodem->buffer[i]);
    checksum += xmodem->buffer[i];
  }
  stdio_putchar_raw(checksum);

  // Wait for host response
  int response = stdio_getchar_timeout_us(XMODEM_TIMEOUT_US);
  if (response == PICO_ERROR_TIMEOUT) {
    xmodem->active = false;
    xmodem->error = XMODEM_ERR_TIMEOUT;
  } else if (response == ACK) {
    // success
    xmodem->block_num++;
    xmodem->buffer_ix = 0;
  } else if (response == NAK) {
    // fail; instead of retry, just abort.
    stdio_putchar_raw(EOT);
    xmodem->active = false;
    xmodem->error = XMODEM_ERR_NACK;
  } else if (response == CAN) {
    // cancel requested
    xmodem->active = false;
    xmodem->error = XMODEM_ERR_CAN;
  }
}

void xmodem_init(xmodem_t* xmodem) {
  xmodem->active = true;
  xmodem->error = XMODEM_ERR_NONE;
  xmodem->block_num = 1;
  xmodem->buffer_ix = 0;

  // Consume all input buffer to stabilize protocol.
  while (true) {
    int res = stdio_getchar_timeout_us(1);
    if (res == PICO_ERROR_TIMEOUT) {
      break;
    }
  }
}

void xmodem_send_text(xmodem_t* xmodem, const char* text) {
  if (!xmodem->active) {
    return;
  }

  const uint8_t* data = (const uint8_t*)text;
  size_t size = strlen(text);

  int ix = 0;
  while (ix < size) {
    size_t data_left = size - ix;
    size_t space_left = XMODEM_BLOCK_SIZE - xmodem->buffer_ix;
    int copy_size = data_left < space_left ? data_left : space_left;

    memcpy(xmodem->buffer + xmodem->buffer_ix, data + ix, copy_size);
    xmodem->buffer_ix += copy_size;
    ix += copy_size;

    if (xmodem->buffer_ix == XMODEM_BLOCK_SIZE) {
      send_block(xmodem);
      if (!xmodem->active) {
        break;
      }
    }
  }
}

bool xmodem_finish(xmodem_t* xmodem, uint8_t padding) {
  if (!xmodem->active) {
    // something is wrong
    return false;
  }

  // Send out incomplete block with padding.
  if (xmodem->buffer_ix > 0) {
    memset(xmodem->buffer + xmodem->buffer_ix, padding,
           XMODEM_BLOCK_SIZE - xmodem->buffer_ix);
    send_block(xmodem);
  }

  if (!xmodem->active) {
    // something is wrong
    return false;
  }

  // end transmission.
  stdio_putchar_raw(EOT);
  int response = stdio_getchar_timeout_us(XMODEM_TIMEOUT_US);
  if (response == PICO_ERROR_TIMEOUT) {
    xmodem->error = XMODEM_ERR_END_TIMEOUT;
  } else if (response != ACK) {
    xmodem->error = XMODEM_ERR_END_NOT_ACK;
  }

  xmodem->active = false;
  return xmodem->error == XMODEM_ERR_NONE;
}
