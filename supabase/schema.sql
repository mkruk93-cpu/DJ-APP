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
  id              integer PRIMARY KEY DEFAULT 1,
  auto_approve    boolean DEFAULT false,
  icecast_url     text
);
INSERT INTO settings (id) VALUES (1);

-- Migration for existing settings table:
-- ALTER TABLE settings ADD COLUMN IF NOT EXISTS icecast_url text;

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

-- Enable Realtime on all tables (run in Supabase SQL editor)
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE requests;
ALTER PUBLICATION supabase_realtime ADD TABLE now_playing;
