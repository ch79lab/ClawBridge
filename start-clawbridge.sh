#!/bin/bash
export ANTHROPIC_API_KEY=$(security find-generic-password -a clawbridge -s clawbridge-anthropic -w)
export GOOGLE_API_KEY=$(security find-generic-password -a clawbridge -s clawbridge-google -w)
export PORT=8402
export SHADOW_MODE=false
export LOG_LEVEL=info
cd /Users/ch79.one/ch79/ClawBridge
exec /opt/homebrew/opt/node@22/bin/node ./node_modules/.bin/tsx src/server.ts
