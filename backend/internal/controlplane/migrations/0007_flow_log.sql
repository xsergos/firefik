CREATE TABLE IF NOT EXISTS flow_log (
    bucket     INTEGER NOT NULL,
    agent_id   TEXT    NOT NULL,
    action     TEXT    NOT NULL DEFAULT '',
    container  TEXT    NOT NULL DEFAULT '',
    src_ip     TEXT    NOT NULL DEFAULT '',
    dst_port   INTEGER NOT NULL DEFAULT 0,
    proto      TEXT    NOT NULL DEFAULT '',
    rule       TEXT    NOT NULL DEFAULT '',
    count      INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    PRIMARY KEY (bucket, agent_id, action, container, src_ip, dst_port, proto, rule)
);
CREATE INDEX IF NOT EXISTS idx_flow_log_last_seen ON flow_log(last_seen);
CREATE INDEX IF NOT EXISTS idx_flow_log_agent_bucket ON flow_log(agent_id, bucket);
