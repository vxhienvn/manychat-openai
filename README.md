# AIGUKA 4.1.6 universal-message-log

Bản này tập trung sửa module log hội thoại để Debug API đọc được đầy đủ hơn:

- Ghi `source` và `external_message_id` cho message nếu DB đã có cột.
- Nếu DB chưa có cột mới, fallback vẫn insert message tối thiểu để không mất tin.
- Ghi log cả các tin bot bị chặn bởi nút tắt bot, sale takeover hoặc chống lặp.
- Ghi log postback/button click của khách.
- Ghi log tin ảnh bot gửi.
- Bổ sung guard sale takeover cho gửi ảnh.
- Debug API trả thêm `source`, `external_message_id` nếu có.

Lưu ý: bản này không cố backfill các tin cũ đã mất trong DB. Sau deploy, các tin mới phát sinh sẽ được ghi tốt hơn.
