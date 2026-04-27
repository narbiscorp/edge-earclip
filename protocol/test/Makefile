# Makefile — build & run the protocol C round-trip test.
#
# This is a host-side (gcc) test only. The earclip firmware build is
# managed separately by ESP-IDF in firmware/.

CC      := gcc
CFLAGS  := -std=c11 -Wall -Wextra -Werror -O0 -g
SRCS    := roundtrip.c ../narbis_protocol.c
OUT     := roundtrip$(if $(filter Windows_NT,$(OS)),.exe,)

.PHONY: all test clean

all: $(OUT)

$(OUT): $(SRCS) ../narbis_protocol.h
	$(CC) $(CFLAGS) -I.. $(SRCS) -o $(OUT)

test: $(OUT)
	./$(OUT)

clean:
	rm -f $(OUT) golden_packets.txt
