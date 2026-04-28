/*
 * max3010x_regs.h — register map for MAX30102 and MAX30101 PPG sensors.
 *
 * The two parts share the same 7-bit I2C address (0x57), the same
 * register address space, and an identical PART_ID (0x15). Functional
 * differences:
 *   - MAX30102: 2 LEDs (red, IR). LED3_PA writes are accepted but the
 *     LED3 driver is not bonded out.
 *   - MAX30101: 3 LEDs (red, IR, green). Multi-LED Mode + slot config
 *     (MULTI_LED_CTRL1/2) drive all three.
 * Comments on individual registers note "(MAX30101 only)" where relevant.
 */

#ifndef NARBIS_MAX3010X_REGS_H
#define NARBIS_MAX3010X_REGS_H

#ifdef __cplusplus
extern "C" {
#endif

/* 7-bit I2C address (datasheet "AE" = 0xAE write / 0xAF read = 0x57 << 1). */
#define MAX3010X_I2C_ADDR              0x57

/* ---------------- Status / Interrupt ---------------- */
#define MAX3010X_REG_INT_STATUS_1      0x00  /* A_FULL, PPG_RDY, ALC_OVF, PWR_RDY */
#define MAX3010X_REG_INT_STATUS_2      0x01  /* DIE_TEMP_RDY */
#define MAX3010X_REG_INT_ENABLE_1      0x02
#define MAX3010X_REG_INT_ENABLE_2      0x03

#define MAX3010X_INT1_A_FULL           (1u << 7)
#define MAX3010X_INT1_PPG_RDY          (1u << 6)
#define MAX3010X_INT1_ALC_OVF          (1u << 5)
#define MAX3010X_INT1_PWR_RDY          (1u << 0)
#define MAX3010X_INT2_DIE_TEMP_RDY     (1u << 1)

/* ---------------- FIFO ---------------- */
#define MAX3010X_REG_FIFO_WR_PTR       0x04  /* 5-bit write index */
#define MAX3010X_REG_OVF_COUNTER       0x05  /* samples lost to overflow */
#define MAX3010X_REG_FIFO_RD_PTR       0x06  /* 5-bit read index */
#define MAX3010X_REG_FIFO_DATA         0x07  /* burst-readable */
#define MAX3010X_FIFO_DEPTH            32u

#define MAX3010X_REG_FIFO_CONFIG       0x08
/* FIFO_CONFIG: SMP_AVE[7:5] | FIFO_ROLLOVER_EN[4] | FIFO_A_FULL[3:0] */
#define MAX3010X_SMP_AVE_1             (0u << 5)
#define MAX3010X_SMP_AVE_2             (1u << 5)
#define MAX3010X_SMP_AVE_4             (2u << 5)
#define MAX3010X_SMP_AVE_8             (3u << 5)
#define MAX3010X_SMP_AVE_16            (4u << 5)
#define MAX3010X_SMP_AVE_32            (5u << 5)
#define MAX3010X_FIFO_ROLLOVER_EN      (1u << 4)
/* FIFO_A_FULL: low nibble = number of empty FIFO slots remaining when the
 * A_FULL interrupt fires. Trigger threshold (unread samples) = 32 - field.
 *   field = 0x0F → fire at 17 unread (recommended)
 *   field = 0x00 → fire at 32 unread (overflow imminent) */

/* ---------------- Mode ---------------- */
#define MAX3010X_REG_MODE_CONFIG       0x09
/* MODE_CONFIG: SHDN[7] | RESET[6] | _[5:3] | MODE[2:0] */
#define MAX3010X_MODE_SHDN             (1u << 7)
#define MAX3010X_MODE_RESET            (1u << 6)
#define MAX3010X_MODE_HR               (0x02u)  /* red only */
#define MAX3010X_MODE_SPO2             (0x03u)  /* red + IR */
#define MAX3010X_MODE_MULTI_LED        (0x07u)  /* slot-driven, MAX30101 */

/* ---------------- SpO2 / sampling ---------------- */
#define MAX3010X_REG_SPO2_CONFIG       0x0A
/* SPO2_CONFIG: _[7] | SPO2_ADC_RGE[6:5] | SPO2_SR[4:2] | LED_PW[1:0] */
#define MAX3010X_ADC_RGE_2048NA        (0u << 5)
#define MAX3010X_ADC_RGE_4096NA        (1u << 5)
#define MAX3010X_ADC_RGE_8192NA        (2u << 5)
#define MAX3010X_ADC_RGE_16384NA       (3u << 5)
#define MAX3010X_SR_50HZ               (0u << 2)
#define MAX3010X_SR_100HZ              (1u << 2)
#define MAX3010X_SR_200HZ              (2u << 2)
#define MAX3010X_SR_400HZ              (3u << 2)
#define MAX3010X_SR_800HZ              (4u << 2)
#define MAX3010X_SR_1000HZ             (5u << 2)
#define MAX3010X_SR_1600HZ             (6u << 2)
#define MAX3010X_SR_3200HZ             (7u << 2)
#define MAX3010X_LED_PW_69US_15BIT     (0u)     /* 69 µs  / 15-bit */
#define MAX3010X_LED_PW_118US_16BIT    (1u)     /* 118 µs / 16-bit */
#define MAX3010X_LED_PW_215US_17BIT    (2u)     /* 215 µs / 17-bit */
#define MAX3010X_LED_PW_411US_18BIT    (3u)     /* 411 µs / 18-bit (default) */

/* ---------------- LED pulse amplitude (one register per LED) ----------------
 * Each register is 0–255, step ≈ 0.2 mA, max ≈ 51 mA. To convert from the
 * protocol's _x10 mA: reg = milliamps_x10 / 2 (since 1 mA_x10 = 0.5 LSB).
 */
#define MAX3010X_REG_LED1_PA           0x0C  /* RED on both chips */
#define MAX3010X_REG_LED2_PA           0x0D  /* IR on both chips */
#define MAX3010X_REG_LED3_PA           0x0E  /* GREEN on MAX30101 */
#define MAX3010X_REG_PILOT_PA          0x10  /* proximity / pilot LED, unused */

/* ---------------- Multi-LED Mode slot config (MAX30101) ---------------- */
#define MAX3010X_REG_MULTI_LED_CTRL1   0x11  /* SLOT2[6:4] | SLOT1[2:0] */
#define MAX3010X_REG_MULTI_LED_CTRL2   0x12  /* SLOT4[6:4] | SLOT3[2:0] */
#define MAX3010X_SLOT_DISABLED         0x00
#define MAX3010X_SLOT_RED              0x01  /* LED1 = red */
#define MAX3010X_SLOT_IR               0x02  /* LED2 = IR  */
#define MAX3010X_SLOT_GREEN            0x03  /* LED3 = green */

/* ---------------- Die temperature (unused this stage) ---------------- */
#define MAX3010X_REG_TEMP_INT          0x1F
#define MAX3010X_REG_TEMP_FRAC         0x20
#define MAX3010X_REG_TEMP_CONFIG       0x21

/* ---------------- Part / revision ID ---------------- */
#define MAX3010X_REG_REV_ID            0xFE  /* differs between fab runs, not chip-type-distinct */
#define MAX3010X_REG_PART_ID           0xFF  /* 0x15 on both MAX30102 and MAX30101 */
#define MAX3010X_PART_ID_VALUE         0x15

#ifdef __cplusplus
}
#endif

#endif /* NARBIS_MAX3010X_REGS_H */
