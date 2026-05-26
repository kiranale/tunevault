# TuneVault Agent v6.2 — pure-Python, zero Oracle client deps
# python-oracledb thin mode + paramiko SSH
# v6.1.1: fix Python 3.6 compat — argparse add_subparsers(required=) is 3.7+
# v6.1.2: fix Python 3.6 compat — subprocess capture_output/text are 3.7+
# v6.2.0: 3-tier watchdog (oracle-proxy.py 3.7.0) — kills hard exit(20) on first miss,
#   adds AGENT_WATCHDOG_DEGRADED_S/RESTART_S/POLL_BACKOFF_MAX_S env thresholds,
#   restart-reason reporting via POST /api/agent/restart-reason, restart-loop detection
VERSION = "6.2.0"
