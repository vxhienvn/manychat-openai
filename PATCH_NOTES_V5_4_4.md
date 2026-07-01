# AIGUKA 5.4.4 - Event Classifier / Conversation vs Activity

## Mục tiêu
Sửa lỗi Pending Scanner nhầm activity/system event của Pancake/Meta thành nhân viên thật đã trả lời.

## Thay đổi
- Thêm `isLikelySystemEventText()` để nhận diện các event như:
  - "Yến Nguyễn đã trả lời một quảng cáo"
  - "... đã trả lời bình luận/comment"
  - "Bạn đang phản hồi bình luận của người dùng..."
  - "Khách vừa gửi image sản phẩm và cần tư vấn mẫu này"
  - activity gắn thẻ/đổi trạng thái/đồng bộ/ghi chú...
- `supabaseRowActorType()` ưu tiên phân loại system event trước role cũ trong DB.
- `isHumanAdminSupabaseRow()` chỉ trả true khi là tin nhắn hội thoại thật, không phải system event.
- `hasSupabaseAdminAfterLastCustomer()` lọc bằng actor classifier thay vì cứ thấy role admin/page/sale là coi sale đã trả lời.
- Timeline hydrate ghi `SystemEvent:` cho event hệ thống, không ghi `Admin:`.

## Kết quả mong đợi
Pending Scanner sẽ không còn skip khách chỉ vì log activity "nhân viên đã trả lời quảng cáo". Chỉ tin nhắn hội thoại thật của nhân viên mới khóa bot.

## Log cần xem sau deploy
- `[SUPABASE_STALE_UNANSWERED_SCAN]`
- `[SUPABASE_STALE_UNANSWERED_SKIP_SAMPLES]`
- `[SUPABASE_STALE_UNANSWERED_PENDING_CREATED]`
- `[PENDING_REPLY_EXECUTE]`
