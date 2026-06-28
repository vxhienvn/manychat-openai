# AIGUKA 4.0.4 - Carousel Admin Image Fix

## Mục tiêu
Khắc phục lỗi carousel hiển thị được trên Messenger nhưng ảnh bị trắng/broken trong Pancake và Meta Business Suite, khiến admin không biết khách đang chọn sản phẩm nào.

## Đã sửa
- Thêm `image_aspect_ratio: "square"` cho generic template.
- Chuẩn hóa card trước khi gửi qua Messenger:
  - tự gắn mã sản phẩm/SKU vào title: `BEP-01`, `BC-01`, `TC-01`, `QUAT-01`, `SEN-01`, `TBVS-01`...
  - xóa/không cho title `example` lọt vào card.
  - subtitle luôn có mã sản phẩm + Hotline 0973693677.
  - thêm `default_action` để mở ảnh/card.
  - thêm nút postback `Chọn <SKU>` để khách bấm chọn đúng mẫu.
  - giữ nút gọi hotline.
- Thêm endpoint `/image-proxy` để proxy ảnh Facebook CDN qua URL Render ổn định hơn.
- Supabase log template sẽ lưu cả `elements` đã chuẩn hóa và `original_elements`.
- Không thay đổi luồng queue/reply engine/supabase logger cũ.

## Cần cấu hình trên Render
Thêm Environment Variable:

```env
AIGUKA_PUBLIC_URL=https://manychat-openai-6oiq.onrender.com
AIGUKA_IMAGE_PROXY_ENABLED=true
```

Nếu không set `AIGUKA_PUBLIC_URL`, bot vẫn chạy nhưng ảnh vẫn dùng URL gốc Facebook CDN, Pancake/Meta Suite có thể tiếp tục không render ảnh.

## Test sau deploy
1. Mở `/healthz`, version phải có `Carousel-Fix`.
2. Gửi thử carousel nhóm bếp/bồn cầu/tủ chậu.
3. Kiểm tra Pancake:
   - card có mã sản phẩm trong title.
   - ảnh không còn chỉ hiện chữ `example`.
   - nếu ảnh vẫn không render, admin vẫn thấy mã sản phẩm rõ trong title/subtitle.
4. Kiểm tra Supabase messages.raw.elements có `sku`.
