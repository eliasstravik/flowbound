#!/bin/bash
# Stop what test/design/seed.ts started: the seed itself and the Flowbounds on its three ports.
for p in ${FULL_PORT:-4611} ${EMPTY_PORT:-4612} ${LIVE_PORT:-4613}; do
  pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "$pid" ] && kill "$pid"
done
for pid in $(ps -eo pid,args | awk '$2 ~ /node$/ && $3 ~ /design\/seed\.ts$/ {print $1}'); do kill "$pid"; done
# The watchers that owned those servers: only the ones started from a throwaway test project.
for pid in $(ps -eo pid,args | grep "[d]ist/core/bin.js dev" | awk '{print $1}'); do
  case "$(readlink /proc/$pid/cwd 2>/dev/null)" in /tmp/flowbound-test-*) kill "$pid" ;; esac
done
exit 0
