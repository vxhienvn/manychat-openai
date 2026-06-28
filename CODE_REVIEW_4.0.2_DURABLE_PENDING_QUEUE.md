# AIGUKA 4.0.2 - Durable Pending Reply Queue

## Mục tiêu
Sửa lỗi khách bị bỏ quên khi Render restart/sleep sau khi bot đã schedule reply 5/10 phút.

## Thay đổi chính
- Thêm cơ chế ghi lịch trả lời vào Supabase `pending_replies`.
- Mỗi khách chỉ còn 1 pending reply; khách nhắn tiếp thì reset `due_at`.
- Timer RAM vẫn giữ để phản hồi nhanh khi server không restart.
- Worker chạy khi server start và mỗi 60 giây để quét pending quá hạn.
- Admin echo sẽ hủy pending reply (`admin_taken`).
- Khách để lại SĐT/Zalo sẽ hủy pending reply (`cancelled`).
- Thêm endpoint kiểm tra `/pending-replies-health`.

## Không thay đổi
- Không đổi Reply Engine hiện tại.
- Không bỏ JSON fallback.
- Không sửa follow-up 8h.
- Không đổi Supabase Logger đã chạy.

## Cần test sau deploy
1. `/healthz` OK.
2. `/supabase-health` OK.
3. Khách nhắn trong giờ làm việc -> bảng `pending_replies` có `status=pending`, `due_at` +10 phút.
4. Khách nhắn thêm trước hạn -> chỉ 1 pending, `due_at` được reset.
5. Restart Render trước hạn -> sau khi server chạy lại, worker xử lý pending quá hạn.
6. Admin trả lời trước hạn -> pending chuyển `admin_taken`.
7. Khách gửi SĐT -> pending chuyển `cancelled`.
