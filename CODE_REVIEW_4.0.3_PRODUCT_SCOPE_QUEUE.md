# AIGUKA 4.0.3 - Product Scope + Event Recognition + Durable Queue patch

## Mục tiêu bản vá
Sửa ngay các lỗi phát sinh trên bản 4.0.1/4.0.2 thay vì để cộng dồn:

1. Khách hỏi đồ bếp nhưng carousel trộn sen vòi/lavabo/phòng tắm.
2. Khách hỏi bồn cầu màu cam/chức năng nhưng bot trả lời quá chung.
3. Nhiều message trong Supabase thiếu `product_group`, `intent`, `page_id`.
4. Giữ Durable Pending Queue 4.0.2 để Render restart không làm mất lịch trả lời.

## Các thay đổi chính

### 1. Chặn gửi sai nhóm sản phẩm
- Sửa lỗi cũ: `getStaticProductItems('kitchen')` trước đây trả về gallery `faucet`.
- Từ 4.0.3, kitchen chỉ được lấy ảnh `kitchen` hoặc ảnh từ Google Drive/Sheet đúng nhóm.
- Nếu không có ảnh đúng nhóm, bot không gửi lẫn sang nhóm khác.

### 2. Không map toilet -> combo
- Trước đây `normalizeMediaProduct('toilet')` trả về `combo`, dễ làm bồn cầu bị trộn với combo/sen/lavabo.
- Từ 4.0.3, toilet giữ nguyên là `toilet`.

### 3. Product Scoped Filter
- Thêm `filterProductItemsByScope()` để lọc ảnh theo nhóm trước khi gửi.
- Với kitchen, loại bỏ ảnh có dấu hiệu sen/lavabo/bồn cầu/phòng tắm/tủ chậu.
- Với fan/toilet cũng có bộ từ khóa chống trộn sản phẩm.

### 4. Event Recognition cơ bản
- Thêm `detectCustomerIntent()`:
  - `ask_price`
  - `price_first`
  - `ask_more_images`
  - `phone_provided`
  - `ask_features`
  - `ask_address`
  - `ask_warranty`
  - `ask_delivery`
  - `general`
- Cập nhật `conversations.current_intent` và `messages.intent`.

### 5. Supabase metadata tốt hơn
- Bot message được log kèm `page_id`, `product_group`, `intent` khi có state.
- Customer state được upsert vào bảng `customer_states`.
- Conversation được cập nhật `product_group/current_intent/last_message_at`.

### 6. Xử lý hỏi tính năng bồn cầu
- Nếu khách hỏi “chức năng thế nào”, “tính năng”, “tự xả”, “sấy”, “UV”, bot trả lời theo rule trước GPT.
- Với toilet: trả lời các tính năng thường có của bồn cầu thông minh và xin SĐT/Zalo để gửi đúng cấu hình.

## Điều chưa làm trong bản này
- Chưa hoàn thiện full Reply Engine 4.0.
- Chưa hoàn thiện mapping `ad_id/post_id` nếu Meta/Pancake không gửi referral trong webhook.
- Chưa nhập dữ liệu ảnh kitchen/toilet/vanity vào static gallery; nếu Google Sheet/Drive chưa có thì bot sẽ không gửi nhầm ảnh, thay vào đó xin SĐT/Zalo.

## Test bắt buộc sau deploy
1. Khách nhắn: `xem đồ bếp` → không được gửi sen/lavabo/phòng tắm.
2. Khách nhắn: `chị xin giá bồn cầu màu cam`, sau đó `chức năng thế nào` → phải trả lời tính năng bồn cầu.
3. Render restart sau khi scheduled reply → pending_replies phải được xử lý lại.
4. Supabase messages phải có `role=bot`, `product_group`, `intent` nhiều hơn bản 4.0.1.
