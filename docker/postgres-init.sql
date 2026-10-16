-- Runs once, on first start of an empty data volume.
-- `flowdesk` (the app database) is created by POSTGRES_DB.
CREATE DATABASE flowdesk_test OWNER flowdesk;

CREATE ROLE n8n WITH LOGIN PASSWORD 'n8n';
CREATE DATABASE n8n OWNER n8n;
