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
                   CHECK (status IN ('pending', 'approved', 'downloaded', 'rejected')),
  created_at  timestamptz DEFAULT now()
);

-- Migration for existing tables:
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS title text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS artist text;
-- ALTER TABLE requests ADD COLUMN IF NOT EXISTS thumbnail text;

-- Now playing track (single-row table, always id=1)
CREATE TABLE now_playing (
  id          integer PRIMARY KEY DEFAULT 1,
  title       text,
  artist      text,
  updated_at  timestamptz DEFAULT now()
);
INSERT INTO now_playing (id) VALUES (1);

-- Enable Realtime on all tables (run in Supabase SQL editor)
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE requests;
ALTER PUBLICATION supabase_realtime ADD TABLE now_playing;
