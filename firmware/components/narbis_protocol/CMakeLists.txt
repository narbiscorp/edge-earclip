# Narbis protocol component — wraps the repo-root protocol/ files (single
# source of truth; same files are consumed by the dashboard via TypeScript).
# We point at them with relative paths instead of copying or symlinking so
# the firmware build stays in sync automatically and Windows hosts (where
# symlinks need elevated permissions) work out of the box.

idf_component_register(
    SRCS         "${COMPONENT_DIR}/../../../protocol/narbis_protocol.c"
    INCLUDE_DIRS "${COMPONENT_DIR}/../../../protocol"
)
