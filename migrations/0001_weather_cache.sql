CREATE TABLE IF NOT EXISTS globe_weather_cache (cache_key TEXT PRIMARY KEY, payload TEXT, expires_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS globe_weather_cache_expiry ON globe_weather_cache(expires_at);
CREATE TABLE IF NOT EXISTS globe_weather_usage (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS globe_weather_usage_expiry ON globe_weather_usage(expires_at);
