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
  duration    integer,
  source      text,
  genre       text,
  genre_confidence text CHECK (genre_confidence IN ('explicit', 'artist_based', 'unknown')),
  status      text DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'downloaded', 'rejected', 'error')),
  created_at  timestamptz DEFAULT now()
);

-- Migration for existing tables:
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS title text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS artist text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS thumbnail text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS duration integer;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS source text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS genre text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS genre_confidence text;
-- ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_genre_confidence_check;
-- ALTER TABLE requests ADD CONSTRAINT requests_genre_confidence_check CHECK (genre_confidence IN ('explicit', 'artist_based', 'unknown'));
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

-- Live polls (DJ can launch one active poll at a time)
CREATE TABLE IF NOT EXISTS live_polls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question    text NOT NULL,
  options     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by  text,
  created_at  timestamptz DEFAULT now(),
  closed_at   timestamptz
);

CREATE TABLE IF NOT EXISTS live_poll_votes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id      uuid NOT NULL REFERENCES live_polls(id) ON DELETE CASCADE,
  nickname     text NOT NULL,
  option_index integer NOT NULL,
  created_at   timestamptz DEFAULT now(),
  UNIQUE (poll_id, nickname)
);

CREATE INDEX IF NOT EXISTS idx_live_poll_votes_poll_id ON live_poll_votes(poll_id);

-- Temporary spotlight messages from DJ to listener
CREATE TABLE IF NOT EXISTS shoutouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname    text NOT NULL,
  message     text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shoutouts_active_expires ON shoutouts(active, expires_at DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE live_polls;
ALTER PUBLICATION supabase_realtime ADD TABLE live_poll_votes;
ALTER PUBLICATION supabase_realtime ADD TABLE shoutouts;

-- Personal user playlists imported from Exportify (CSV/ZIP)
CREATE TABLE IF NOT EXISTS user_playlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname    text NOT NULL,
  device_id   text NOT NULL,
  name        text NOT NULL,
  source      text NOT NULL DEFAULT 'exportify',
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_playlist_tracks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id  uuid NOT NULL REFERENCES user_playlists(id) ON DELETE CASCADE,
  title        text NOT NULL,
  artist       text,
  album        text,
  spotify_url  text,
  position     integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_playlists_owner
  ON user_playlists(nickname, device_id);

CREATE INDEX IF NOT EXISTS idx_user_playlist_tracks_position
  ON user_playlist_tracks(playlist_id, position);
