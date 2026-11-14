-- Multi-bot per-key encrypted webhook routing (zero plaintext secrets stored in D1)
ALTER TABLE api_keys ADD COLUMN notify_webhook_ciphertext TEXT NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN notify_webhook_host TEXT NOT NULL DEFAULT '';
