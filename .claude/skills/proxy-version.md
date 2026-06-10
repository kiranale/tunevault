# oracle-proxy.py Version Management

Current version: 3.20.36

When making ANY change to oracle-proxy.py:
1. Bump VERSION = "3.20.XX" at top of file
2. Update LATEST_PROXY_VERSION in server.js
3. Update LATEST_PROXY_VERSION in routes/agent.js  
4. Update LATEST_PROXY_VERSION in routes/connections-list.js
5. Add entry to CLAUDE.md Recent Changes

Never skip the version bump — agents auto-upgrade based on version mismatch.
Agents on ebs12212-db-dev (conn 134) and ebs12212-app-dev (conn 140) auto-upgrade within 5 minutes of server deploy.
