/*
 * test_inject.h — Kconfig-gated synthetic PPG source for end-to-end DSP
 * smoke testing without hardware. Generates a 1 Hz sine on the IR channel
 * at 200 Hz, with a DC offset inside the AGC target band.
 */

#ifndef NARBIS_TEST_INJECT_H
#define NARBIS_TEST_INJECT_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t test_inject_start(void);
esp_err_t test_inject_stop(void);

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_TEST_INJECT_H */
