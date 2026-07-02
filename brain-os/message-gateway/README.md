# Message Gateway

Từ 5.4.6, mọi tin nhắn outbound của AIGUKA phải đi qua Message Gateway.

Mục tiêu:
- Không còn trường hợp Bot OFF nhưng worker vẫn gửi.
- Mọi tin gửi ra Messenger đều có trace_id, source, messageType và preview.
- SAFE_SEND không được DONE rỗng: nếu câu trả lời bị chặn vì xin SĐT/Zalo lặp lại, Gateway rewrite sang câu trả lời Messenger-care có giá trị.
- Không module nào được gọi Facebook Send API trực tiếp ngoài Gateway.

Log cần theo dõi:
- [MESSAGE_GATEWAY_SEND_REQUEST]
- [MESSAGE_GATEWAY_SEND_RESULT]
- [MESSAGE_GATEWAY_REWRITE]
- [PENDING_BLOCKED_NOT_DONE]
