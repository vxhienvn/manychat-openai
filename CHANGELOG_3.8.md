# AIGUKA 3.8 - Meta Direct CRM

## Mục tiêu
Giảm phụ thuộc Pancake khi Pancake lỗi. Bot lưu dữ liệu khách trực tiếp từ Meta Webhook và dashboard có thể xem theo Meta trực tiếp / Pancake / So sánh.

## Đã thêm
- `message_events.json`: lưu từng tin nhắn khách nhận từ Meta Webhook.
- `internal_customers.json`: tổng hợp khách theo `page_id + sender_id`.
- Tự nhận diện SĐT, Zalo, sản phẩm, khách nóng và gắn nhãn nội bộ.
- Dashboard có dropdown `Nguồn tin nhắn`:
  - Meta trực tiếp
  - Pancake
  - So sánh Meta/Pancake
- Pancake lỗi không làm dashboard lỗi đỏ: dùng dữ liệu Meta trực tiếp và hiển thị cảnh báo.
- Endpoint debug:
  - `/internal-crm-debug`
  - `/internal-customer-history?key=<page_id:sender_id>`
- Bot vẫn đọc lịch sử cũ từ `conversations.json` và bổ sung nguồn dữ liệu nội bộ mới từ lúc deploy 3.8.

## Lưu ý
- Dữ liệu Meta trực tiếp chỉ đầy đủ từ thời điểm deploy 3.8 trở đi.
- Lịch sử trước 3.8 vẫn lấy từ `conversations.json` hoặc Pancake/cache nếu còn truy cập được.
- File JSON trên Render có thể bị mất khi redeploy tùy cấu hình lưu trữ. Về lâu dài nên chuyển sang PostgreSQL/SQLite có persistent disk.
