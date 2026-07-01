# AIGUKA V5.2.2 Gateway Control UI

## Mục tiêu
Hoàn thiện điều khiển Gateway trong `/admin-v5` để vận hành 2 server song song nhưng chỉ 1 server được xử lý Messenger và ghi Supabase.

## Thay đổi chính
- Nâng version lên `5.2.2-gateway-control-ui`.
- `/admin-v5` có card Server Control rõ hơn:
  - Server đang mở trang hiện tại.
  - Server đang xử lý Messenger.
  - Nút `Tắt cả hai`, `Bật AIGUKA`, `Bật AIGUKA-Plus`.
  - Hiển thị AIGUKA / AIGUKA-Plus: ACTIVE/STANDBY/OFF, ONLINE/OFFLINE, heartbeat và URL.
  - Auto refresh 10 giây.
- `/api/server-control` trả thêm `view` và header `no-cache` để tránh giao diện đọc dữ liệu cũ.
- Thêm heartbeat nhẹ mỗi 30 giây để biết server nào còn sống.
- Không bật auto-failover tự động ở bản này để tránh chuyển nhầm khi đang bán hàng.

## Quy tắc vận hành
- `active_server = none`: cả hai server không xử lý thật.
- `active_server = aiguka`: chỉ AIGUKA xử lý.
- `active_server = aiguka_plus`: AIGUKA Gateway forward sang AIGUKA-Plus; Plus xử lý.

## Cần chạy SQL
Chạy file `SUPABASE_PATCH_V5_2_2.sql` trước hoặc ngay sau khi deploy để bổ sung cột heartbeat.
