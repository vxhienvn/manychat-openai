# PATCH NOTES V5.4.3 - Actor Identity + Waiting Customer Detector

## Sửa lỗi gốc
Bản trước gom quá nhiều tin Page/Pancake/Botcake/Meta auto vào `admin`, làm Pending Engine tưởng sale đã trả lời thật.

## Cập nhật
- Thêm Actor Identity Classifier:
  - `human_admin`
  - `aiguka_bot`
  - `botcake`
  - `pancake_auto`
  - `meta_auto`
  - `page_unknown`
  - `customer`
- Chỉ `human_admin` mới kích hoạt admin takeover/sale lock.
- Meta echo/page outbound không rõ người nhắn mặc định là `page_unknown`, không khóa bot.
- Pancake sync cố gắng lấy `actor_name` từ metadata; nếu là Botcake/auto thì không khóa bot.
- Supabase stale scanner không còn chỉ kiểm tra “tin cuối là customer”; thay bằng Waiting Customer Detector:
  - tìm tin khách gần nhất,
  - kiểm tra sau đó có `human_admin` thật trả lời chưa,
  - nếu chưa, quá thời gian chờ và không có SĐT/Zalo thì tạo pending.

## Env tùy chọn
- `AIGUKA_HUMAN_ADMIN_NAMES="Yến Nguyễn;Nga Dương;Tên Nhân Viên"`
- `AIGUKA_BOT_ACTOR_NAMES="Botcake;AIGUKA;ManyChat"`
