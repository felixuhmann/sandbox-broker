#!/bin/bash
# Inert PID 1.
#
# This script must never execute caller-supplied input. The broker refuses to
# run any command until the sandbox network policy has been applied and
# verified, so container start deliberately does nothing but wait.
set -euo pipefail

# Idle without burning CPU. tini forwards SIGTERM here, so stop/restart is fast.
exec sleep infinity
