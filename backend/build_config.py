#!/usr/bin/env python3
"""
Builds the real config.json for one poller run, by merging
config.template.json (server IDs, IPs, ports — nothing secret, safe to
commit) with credentials read from environment variables. In GitHub
Actions those env vars come from this repo's encrypted Secrets (see
README.md for exactly which ones to add and where) — they're never
written to any file that gets committed, only to a config.json that
lives in the CI runner's throwaway workspace for the few seconds this
job runs, then is discarded when the job ends.

Usage: python3 build_config.py > config.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(HERE, "config.template.json"), encoding="utf-8") as f:
    cfg = json.load(f)

cfg.pop("_comment", None)

nitrado_token = os.environ.get("NITRADO_TOKEN")
if nitrado_token:
    cfg["nitrado_token"] = nitrado_token

ark_rcon_password = os.environ.get("ARK_RCON_PASSWORD")
if ark_rcon_password:
    cfg["ark_rcon_password"] = ark_rcon_password

# One env var per Palworld server, keyed by that server's service_id so
# adding a third Palworld server later is just one more secret + one
# more line here, not a restructuring.
palworld_password_env = {
    "17667688": "PALWORLD_1_PASSWORD",
    "19733590": "PALWORLD_2_PASSWORD",
}
for server in cfg.get("palworld_servers", []):
    env_name = palworld_password_env.get(str(server.get("service_id")))
    password = os.environ.get(env_name) if env_name else None
    if password:
        server["password"] = password

json.dump(cfg, sys.stdout, indent=2)
