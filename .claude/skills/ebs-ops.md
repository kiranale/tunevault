# EBS Ops SQL Execution

EBS APPS schema queries must run as APPS user, not TUNEVAULT_READER.

Connection pairing:
- App tier: conn 140 (ebs12212-app-dev, server_type='apps', ebs_instance_name='EBS12212')
- DB tier: conn 134 (ebs12212-db-dev, server_type='db', ebs_instance_name='EBS12212')

When routing EBS SQL through paired DB agent:
- Send to conn 134 agent via channel.sendToAgent()
- Use username: 'APPS'
- Use password: decrypt(conn140.apps_pwd_enc)
- Use service_name: 'EBSDB'
- Pairing key: ebs_instance_name must match between app and DB connections

getConnParams() must SELECT: server_type, ebs_instance_name, apps_pwd_enc
Return object must include: appsPassword: decrypt(conn.apps_pwd_enc)
