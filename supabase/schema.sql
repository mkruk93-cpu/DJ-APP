-- Chat messages table
CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname    text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

-- Music request table
CREATE TABLE requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname    text NOT NULL,
  url         text NOT NULL,
  title       text,
  artist      text,
  thumbnail   text,
  status      text DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'downloaded', 'rejected', 'error')),
  created_at  timestamptz DEFAULT now()
);

-- Migration for existing tables:
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS title text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS artist text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS thumbnail text;
-- ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
-- ALTER TABLE requests ADD CONSTRAINT requests_status_check CHECK (status IN ('pending', 'approved', 'downloaded', 'rejected', 'error'));

-- App settings (single-row table, always id=1)
CREATE TABLE settings (
  id                integer PRIMARY KEY DEFAULT 1,
  auto_approve      boolean DEFAULT false,
  icecast_url       text,
  radio_server_url  text
);
INSERT INTO settings (id) VALUES (1);

-- Migration for existing settings table:
-- ALTER TABLE settings ADD COLUMN IF NOT EXISTS icecast_url text;
-- ALTER TABLE settings ADD COLUMN IF NOT EXISTS radio_server_url text;

-- Now playing track (single-row table, always id=1)
CREATE TABLE now_playing (
  id          integer PRIMARY KEY DEFAULT 1,
  title       text,
  artist      text,
  artwork_url text,
  updated_at  timestamptz DEFAULT now()
);
INSERT INTO now_playing (id) VALUES (1);

-- Migration for existing now_playing table:
-- ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS artwork_url text;

-- =====================================================================
-- RADIO MODE TABLES (added alongside existing tables)
-- =====================================================================

-- Radio queue — tracks waiting to be played by the control server
CREATE TABLE queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_url text NOT NULL,
  youtube_id  text NOT NULL,
  title       text,
  thumbnail   text,
  added_by    text DEFAULT 'anonymous',
  position    integer NOT NULL,
  created_at  timestamptz DEFAULT now()
);

-- Radio settings — key-value store (separate from the existing settings table)
CREATE TABLE radio_settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- Default radio settings (run once)
INSERT INTO radio_settings (key, value) VALUES
  ('active_mode',         '"radio"'),
  ('democracy_threshold', '51'),
  ('democracy_timer',     '15'),
  ('jukebox_max_per_user','5'),
  ('party_skip_cooldown', '10'),
  ('stream_url',          '""');

-- Played history — log of tracks played by the radio server
CREATE TABLE played_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id  text NOT NULL,
  title       text,
  thumbnail   text,
  played_at   timestamptz DEFAULT now(),
  duration_s  integer
);

-- Enable Realtime on all tables (run in Supabase SQL editor)
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE requests;
ALTER PUBLICATION supabase_realtime ADD TABLE now_playing;
ALTER PUBLICATION supabase_realtime ADD TABLE queue;
ALTER PUBLICATION supabase_realtime ADD TABLE radio_settings;
