# AIGUKA V5.2.3 - Sale Center Modular

## Mục tiêu
- Tách logic giờ làm việc và chế độ bot thành module `src/sale-center/scheduleService.js`.
- Làm lại trang `/admin/ad-mapping.html` thành trang dành riêng cho sale tự chỉnh lịch.
- Hỗ trợ 3 chế độ theo từng khung giờ: `on`, `off`, `support`.

## Thay đổi chính
- Version: `5.2.3-sale-center-modular`.
- API mới:
  - `GET /api/sale-center/config`
  - `GET /api/sale-center/status`
- API cũ `/api/working-settings` vẫn giữ để tương thích.
- Supabase thêm cột:
  - `bot_mode`
  - `support_wait_minutes`
  - `working_windows`
  - `after_hours_windows`

## Ý nghĩa chế độ
- `ON`: bot trả lời ngay.
- `OFF`: bot không tự động trả lời trong khung giờ đó.
- `HỖ TRỢ`: bot chờ `support_wait_minutes`; nếu sale chưa trả lời thì bot mới hỗ trợ.

## Deploy
1. Chạy `database/SUPABASE_PATCH_V5_2_3.sql` trong Supabase.
2. Commit + push code.
3. Render deploy AIGUKA test trước.
4. Kiểm tra `/admin/ad-mapping.html`.
5. Khi ổn mới deploy AIGUKA-Plus thủ công.
