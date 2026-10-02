#!/usr/bin/env bash
# Test stand-in for the agy binary's hub face: same argv, mocked behaviour.
exec node "$(dirname "$0")/mock_agy_hub.mjs" "$@"
