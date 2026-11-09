-- Supabase tự mở schema public qua REST API (PostgREST) cho role anon/authenticated:
-- ai có "anon key" (công khai) đều gọi được, kể cả đọc bảng users có password_hash.
-- App này không dùng API đó (server kết nối thẳng vào Postgres), nên khóa lại:
--   1. Bật RLS trên mọi bảng, không tạo policy nào → anon/authenticated bị chặn hết.
--      Server kết nối bằng role chủ sở hữu bảng nên không bị RLS ảnh hưởng.
--   2. Thu hồi quyền của anon/authenticated, kể cả với bảng tạo sau này.
-- Trên Postgres thường (Docker) không có role anon nên bước 2 được bỏ qua.
-- Quy ước: migration tạo bảng mới phải ENABLE ROW LEVEL SECURITY (có test kiểm tra).

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;
