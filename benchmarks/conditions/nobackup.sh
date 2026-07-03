#!/usr/bin/env bash
# Condition: nobackup — the control (no backup installed; nothing to restore).
# Used by RegretBench (coverage==damage baseline) and as a general control.
cond_nobackup_install()  { :; }
cond_nobackup_disk_ms()  { echo "0 0"; }
cond_nobackup_coverage() { echo 0; }
