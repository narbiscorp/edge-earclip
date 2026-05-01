# Re-uses the protocol header + .c from the repo's top-level protocol/
# directory so the IBI payload struct, peer-role enum, and UUID constants
# stay in sync with the earclip and dashboard. No copy — single source of
# truth lives at protocol/narbis_protocol.{h,c}.
idf_component_register(
    SRCS "../../../../protocol/narbis_protocol.c"
    INCLUDE_DIRS "../../../../protocol"
)
