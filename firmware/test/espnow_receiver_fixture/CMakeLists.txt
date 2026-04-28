cmake_minimum_required(VERSION 3.16)

# Pull in the existing narbis_protocol component from the earclip firmware so
# the receiver and transmitter agree on the wire format byte-for-byte.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(espnow_receiver_fixture)
