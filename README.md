# AIGUKA 4.3.1 dashboard-account-contact-menu

Bản cập nhật giữ nền 4.3.0 và bổ sung theo yêu cầu dashboard:

- Dropdown lọc theo tài khoản quảng cáo trên dashboard.
- Bảng hiệu quả quảng cáo lọc theo tài khoản QC.
- Bảng khách đã có liên hệ lọc theo tài khoản QC.
- Thêm cột Tài khoản QC và Tên quảng cáo trong bảng khách đã có SĐT/Zalo.
- Gộp SĐT và Zalo dạng số vào một cột SĐT/Zalo.
- Nếu khách không có SĐT nhưng có QR/tag Zalo thì vẫn đưa vào nhóm khách đã có SĐT/Zalo, hiển thị "Zalo/QR hoặc đã tag Zalo".
- Tích hợp nhận diện số điện thoại trong dữ liệu Pancake từ recent_phone_numbers, snippet và tag.
- Thêm thanh menu nhanh đến Dashboard, báo cáo tháng, admin mapping/lịch bot, debug health, sync Messenger, Pancake review, bật/tắt bot.

Kiểm tra cú pháp:
- node --check src/app.js
- node --check server.js
- node --check src/services/pancakeService.js
