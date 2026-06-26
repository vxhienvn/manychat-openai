# AIGUKA CHANGELOG

## v3.9.6 - Dashboard Source Fix + Product Engine V1

### Dashboard
- Hoàn thiện logic dropdown nguồn tin nhắn.
- Meta Direct hiển thị hội thoại theo Meta account/day Insights.
- Pancake hiển thị hội thoại theo dữ liệu Pancake/Webhook, không dùng chung số Meta.
- Đổi nhãn thẻ tổng quan: “Hội thoại Meta Account”, “Hội thoại Pancake” để tránh nhầm.

### Product Engine V1
- Thêm service đọc ảnh Google Drive theo `Folder` trong Google Sheet.
- Thêm endpoint `/product-drive-debug` để kiểm tra folder ảnh.
- Hỗ trợ biến môi trường `GOOGLE_DRIVE_PRODUCTS_ROOT_ID` và `GOOGLE_DRIVE_API_KEY`.
- Nếu chưa cấu hình Google Drive hoặc chưa có ảnh Drive, bot tự fallback về bộ ảnh mẫu cũ để không gãy tư vấn.

### PHOTO_RULE V2.0
- 1–4 ảnh: gửi toàn bộ ảnh lẻ.
- Từ 5 ảnh trở lên: gửi Slide 1 bằng carousel 5–10 ảnh.
- Nếu khách đòi xem tiếp: gửi Slide 2 gồm phần ảnh còn lại.
- Sau Slide 2: chèn câu xin SĐT/Zalo vì Messenger dễ trôi tin và gửi nhiều ảnh sẽ nặng.
- Bot nhớ trạng thái slide theo từng khách/từng nhóm ảnh để không gửi lại Slide 1 khi khách hỏi tiếp.

### Price Rule
- Tiếp tục khóa nguyên tắc chỉ báo khoảng giá min–max từ Google Sheet.
- Không báo giá cụ thể từng mẫu/model/ảnh trên Messenger.

---

## v3.9.5 - Dashboard Meta/Pancake source lock

### Dashboard
- Khóa logic Meta Direct: số hội thoại chỉ lấy từ Meta account/day Insights, không fallback sang webhook/Pancake.
- Sửa báo cáo tháng: nguồn Meta không còn lấy `max(webhook, Meta)` nên không bị lệch 17 → 21 hoặc 80.
- Header dashboard hiển thị rõ nguồn hiện tại và số hội thoại Meta Direct.
- Thêm endpoint `/dashboard-source-debug` để so sánh nhanh 3 nguồn: Meta, ad-level, Pancake/webhook.

### Quản lý release
- Từ bản này chỉ giữ một file `CHANGELOG.md` duy nhất.
- Không còn các file `CHANGELOG_3.x.x.md` rời rạc.

## v3.9.4 - Fix Meta daily conversation total
- Meta Direct tổng hội thoại theo Meta account/day để khớp Ads Manager và báo cáo tháng.
- SĐT/Zalo vẫn là dữ liệu bổ sung từ webhook/Pancake.

## v3.9.3 - Fix dashboard currentDataSource
- Sửa lỗi `currentDataSource is not defined` làm trắng dashboard.

## v3.9.2 - Fix Meta/Pancake source separation
- Tách nguồn hội thoại Meta Direct và Pancake/Webhook.
- Meta Direct không dùng số hội thoại Pancake làm tổng chính.

## v3.9.1 - Meta messages fallback fix
- Đọc thêm `actions` từ Meta Ads để lấy số hội thoại.
- Tăng khả năng map ad_id từ Pancake.

## v3.9.0 - Product Sheet Parser
- Đọc Google Sheet bảng giá theo cấu trúc showroom.
- Chỉ báo giá min → max, không báo giá từng mẫu.

## v3.8.4 - Product Sheet Price Range
- Thêm Product Sheet engine sơ bộ.

## v3.8.3 - Meta month messages/payment
- Dashboard tháng theo giờ Meta.
- Bổ sung dữ liệu tin nhắn/ngày, tài khoản, chi tiêu và thanh toán.

## v3.8.x - Dashboard source/UI fixes
- Sửa giao diện dashboard.
- Ẩn dropdown số dòng khi xem Meta.
- Cảnh báo Pancake lỗi.

## v3.7.x - Finance dashboard
- Dashboard tài chính nhiều tài khoản.
- Bổ sung cột tài khoản quảng cáo, chi tiêu, thẻ thanh toán.

## v3.6.x - Multi-account/timezone
- Hỗ trợ nhiều tài khoản quảng cáo.
- Hỗ trợ múi giờ tài khoản Meta.

## v3.5.x - Admin takeover robust
- Admin trả lời thủ công thì bot dừng ngay.
- Trong 10 phút nếu khách nhắn thêm, bot chỉ lưu không chen ngang.
- Sau 10 phút nếu admin không trả lời tiếp, bot đọc lại hội thoại rồi mới trả lời.
