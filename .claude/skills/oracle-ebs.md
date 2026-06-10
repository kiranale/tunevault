# Oracle EBS Architecture

Lab environment:
- ebs12212-db-dev (conn 134): Oracle 19c DB server, has cx_Oracle/python-oracledb, proxy 3.20.36
- ebs12212-app-dev (conn 140): EBS 12.2 app tier, NO Oracle driver, proxy 3.20.36

EBS checks run as applmgr OS user via su wrapper in oracle-proxy.py.
Admin scripts are in $ADMIN_SCRIPTS_HOME (set by sourcing EBSapps.env).
Never use $AD_TOP/bin — always use script names without path prefix.
WF Mailer cannot be started via command line — use OAM UI or PL/SQL.
Invalid objects fix runs on DB server, not app server.

Key EBS commands (run as applmgr):
- Managed server: admanagedsrvctl.sh start/stop <server_name>
- Apache: adapcctl.sh start/stop
- OPMN: adopmnctl.sh start/stop
- Admin Server: adadminsrvctl.sh start/stop
- Node Manager: adnodemgrctl.sh start/stop
- Apps Listener: adalnctl.sh start/stop
- CM: adcmctl.sh start/stop apps/<password>
