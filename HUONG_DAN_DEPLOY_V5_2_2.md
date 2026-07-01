# Hướng dẫn deploy AIGUKA V5.2.2

## 1. Chạy Supabase SQL
Mở Supabase SQL Editor, dán và chạy toàn bộ nội dung file:

`SUPABASE_PATCH_V5_2_2.sql`

Sau khi chạy xong, bảng `server_control` sẽ có đủ:
- `active_server`
- `aiguka_url`
- `aiguka_plus_url`
- `aiguka_heartbeat_at`
- `aiguka_plus_heartbeat_at`

## 2. Environment cần có

### AIGUKA Gateway
```env
SERVER_ID=aiguka
FORWARD_URL=https://aiguka-plus.onrender.com/webhook
```

### AIGUKA-Plus
```env
SERVER_ID=aiguka_plus
```

Các key khác copy như Production cũ: `OPENAI_API_KEY`, `VERIFY_TOKEN`, `PAGE_ACCESS_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, ...

## 3. Deploy code
Trong Codespaces:

```bash
node -c src/app.js
git status
git add .
git commit -m "AIGUKA V5.2.2 Gateway Control UI"
git push origin main
```

Sau đó Render sẽ auto deploy cả AIGUKA và AIGUKA-Plus. Nếu service nào chưa deploy, bấm:

`Manual Deploy -> Deploy latest commit`

## 4. Kiểm tra
Mở:

```text
https://manychat-openai-6oiq.onrender.com/admin-v5?v=522
```

Phải thấy card:

```text
Server Control
Server đang mở trang này
Server đang xử lý Messenger
AIGUKA / AIGUKA-Plus ONLINE/OFFLINE
```

## 5. Cách vận hành
- Muốn tắt hoàn toàn: bấm `Tắt cả hai`.
- Muốn chạy AIGUKA: bấm `Bật AIGUKA`.
- Muốn chạy AIGUKA-Plus: bấm `Bật AIGUKA-Plus`.

Chỉ server được chọn mới xử lý Messenger, ghi Supabase và gửi tin.
