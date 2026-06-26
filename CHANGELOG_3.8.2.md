# AIGUKA v3.8.2

- Sửa báo cáo tháng Meta: cột Tin nhắn/SĐT/Zalo lấy từ `message_events.json` theo từng ngày Meta thay vì đếm khách theo ngày cập nhật cuối.
- Thêm đường kẻ cột rõ hơn trong bảng báo cáo tài chính/tháng.
- Thêm best-effort đọc `funding_source_details` từ Meta để lấy 4 số cuối thẻ nếu token/account cho phép.
- Thêm endpoint debug `/meta-billing-debug` để kiểm tra token có đọc được thẻ từ Meta hay không.
- Cột Visa vẫn fallback theo thứ tự: payment webhook → Meta funding details → `META_ACCOUNT_CARD_MAP` → `META_CARD_LAST4`.
