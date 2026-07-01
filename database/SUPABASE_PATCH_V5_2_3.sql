-- AIGUKA V5.2.3 Sale Center Modular
-- Chạy một lần trong Supabase SQL Editor.

ALTER TABLE bot_working_settings
  ADD COLUMN IF NOT EXISTS bot_mode text NOT NULL DEFAULT 'support',
  ADD COLUMN IF NOT EXISTS support_wait_minutes int NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS working_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS after_hours_windows jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE bot_working_settings
SET
  bot_mode = COALESCE(NULLIF(bot_mode, ''), 'support'),
  support_wait_minutes = COALESCE(NULLIF(support_wait_minutes, 0), customer_wait_minutes, 10),
  working_windows = CASE
    WHEN working_windows IS NULL OR jsonb_array_length(working_windows) = 0 THEN
      '[{"enabled":true,"name":"Sáng","start":"08:00","end":"12:00","mode":"off"},{"enabled":true,"name":"Chiều","start":"13:30","end":"17:30","mode":"off"}]'::jsonb
    ELSE working_windows
  END,
  after_hours_windows = CASE
    WHEN after_hours_windows IS NULL OR jsonb_array_length(after_hours_windows) = 0 THEN
      '[{"enabled":true,"name":"Tối","start":"17:30","end":"22:00","mode":"support"},{"enabled":true,"name":"Đêm","start":"22:00","end":"08:00","mode":"support"}]'::jsonb
    ELSE after_hours_windows
  END,
  updated_at = now()
WHERE setting_key = 'default';

NOTIFY pgrst, 'reload schema';
