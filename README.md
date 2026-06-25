# manychat-openai

## Hotfix admin takeover v3.5

- Admin trả lời thủ công: bot dừng ngay 10 phút.
- Khách nhắn trong 10 phút: bot chỉ lưu, không trả lời.
- Sau 10 phút nếu admin không trả lời tiếp: bot đọc lại 30 dòng hội thoại gần nhất rồi mới trả lời.
- Nếu admin trả lời tiếp: tự reset thêm 10 phút.
- Đã tăng độ chắc chắn bằng cách so sánh echo với các tin bot vừa gửi để tránh nhầm echo bot là admin.
