# PATCH NOTES V5.4.6 - Message Gateway + Trace

## Mục tiêu
Chặn triệt để lỗi AIGUKA vẫn gửi khi Bot OFF hoặc không biết tin nhắn do luồng nào gửi.

## Thay đổi chính
- Thêm Message Gateway cho text/template/image outbound.
- Mọi tin gửi ra Meta có log trace:
  - `[MESSAGE_GATEWAY_SEND_REQUEST]`
  - `[MESSAGE_GATEWAY_SEND_RESULT]`
- Nếu SAFE_SEND chặn vì xin SĐT/Zalo lặp lại, Gateway rewrite sang câu trả lời Messenger-care có giá trị, không xin số.
- PRICE_INQUIRY chỉ trả lời khoảng giá chung/khai thác nhu cầu, không xin số ngay.
- Pending fallback nếu bị Gateway chặn sẽ không đánh dấu DONE rỗng.
- Thêm `brain-os/message-gateway/README.md` và Article 23.

## Log cần kiểm tra sau deploy
```bash
[MESSAGE_GATEWAY_SEND_REQUEST]
[MESSAGE_GATEWAY_SEND_RESULT]
[MESSAGE_GATEWAY_REWRITE]
[PENDING_BLOCKED_NOT_DONE]
```
