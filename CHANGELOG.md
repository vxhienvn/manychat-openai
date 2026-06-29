
## AIGUKA 4.0.5 - Hard Product Lock + Wrong Product Recovery
- Fix Messenger API 400 caused by unsupported `sku` key in carousel elements.
- Add strict template sanitizer before sending generic templates.
- Add wrong-product complaint recovery.
- Add instant sample slide for photo/sample/catalogue requests.
- Improve Supabase logging for admin/echo_unknown.
- Update health endpoint versions to 4.0.5.

# AIGUKA 4.0.0 - Workflow Engine + Welcome Product Showcase

## Mục tiêu
- Code quyết định workflow, AI chỉ diễn đạt khi thật sự cần.
- Giảm lỗi bot trả lời máy móc, lặp câu, nhảy sai sản phẩm.

## Tính năng chính
- Admin Priority mặc định bật: admin/page trả lời thủ công thì bot dừng.
- Smart Timer theo giờ Việt Nam: 08:00-22:00 chờ 10 phút, 22:00-08:00 chờ 5 phút. Khách nhắn tiếp sẽ reset timer.
- Silent Mode: khách để SĐT/Zalo trong giờ làm việc thì bot chỉ lưu và dừng, không nhắn thêm.
- Outside Office Ack: khách để SĐT/Zalo ngoài giờ thì bot gửi đúng 1 tin xác nhận rồi dừng.
- Product Lock: khóa nhóm sản phẩm theo quảng cáo / câu khách nói rõ, tránh đang quạt nhảy sang bếp.
- AD_PRODUCT_MAP: hỗ trợ map ad_id/ref/campaign_id/adgroup_id sang nhóm sản phẩm bằng biến môi trường JSON.
- Welcome Product Showcase: lần đầu bot trả lời trong phiên quảng cáo sẽ gửi carousel mở đầu trước tin nhắn, không gửi ảnh lẻ.
- Carousel mở đầu luôn có subtitle: Chi tiết và báo giá liên hệ Hotline 0973693677.
- Slide xem thêm không trùng nội dung đã gửi; đến lần xin thêm thứ 3 thì chuyển sang xin SĐT/Zalo.
- Price First Objection: xử lý câu kiểu “báo giá rồi gửi số”, “bao nhiêu tiền mới mua”, không quay lại câu máy móc “cần kiểm tra đúng mẫu”.

## Lưu ý deploy
- Sau deploy, bot trong giờ làm việc sẽ không trả lời ngay mà chờ 10 phút. Đây là đúng thiết kế.
- Nếu muốn nhận diện quảng cáo chính xác hơn, khai báo AD_PRODUCT_MAP trên Render. Ví dụ:
```json
{"123456789":"fan","993446496879173":"toilet"}
```

---

## 3.9.12 - Add Bathroom vanity cabinet mirror intent

- Cập nhật từ nền 3.9.11.
- Bổ sung intent `vanity` cho nhóm tủ chậu gương / tủ lavabo / bộ tủ chậu / gương lavabo.
- Không còn hiểu nhầm `tủ chậu`, `tủ lavabo` thành tủ bếp hoặc combo phòng tắm.
- Khi khách xin mẫu/xem thêm, bot đọc ảnh từ thư mục Google Drive `Bathroom/tủ chậu gương` theo PHOTO_RULE.
- Thêm fallback product row để vẫn gửi được mẫu nếu Google Sheet chưa kịp thêm dòng tủ chậu gương.
- Cập nhật câu hỏi nhu cầu, câu xin SĐT/Zalo, câu intro/close carousel cho nhóm tủ chậu gương.

---


## 3.9.11 - Conversation Intent Fix for TBVS

- Cập nhật từ nền 3.9.10.
- Sửa intent bồn cầu thông minh/bệt/toilet/WC thành nhóm riêng `toilet`, không nhầm sang combo phòng tắm.
- Nếu khách chỉ nhắn mơ hồ `bồn/bon/bồn này/bon này`, bot hỏi lại bồn cầu, bồn tắm hay lavabo/bồn rửa mặt.
- Nếu khách chỉ nhắn `Bắt đầu`, `hi`, `alo`, `.`, `?` hoặc ký tự khó hiểu, bot hỏi khách quan tâm nhóm sản phẩm nào và mời để lại SĐT/Zalo.
- Trả lời bồn cầu thông minh tự nhiên hơn: AI, cảm ứng mở nắp, tự xả, tự phun rửa, sấy, UV khử khuẩn, điều khiển từ xa/giọng nói; sau đó xin SĐT/Zalo.
- Cập nhật prompt và sales engine để ưu tiên sản phẩm cụ thể trước, combo là lựa chọn cuối.

# AIGUKA CHANGELOG

## v3.9.10 - Stable replies, echo-safe, PHOTO request priority

### Sửa lỗi bot không trả lời sau bản mới
- Mặc định không còn coi mọi echo từ Page/auto-reply là admin takeover.
- Tránh trường hợp auto-reply quảng cáo làm bot pause 10 phút khiến khách nhắn “Xin mẫu” nhưng bot im lặng.
- Nếu cần bật lại admin takeover qua echo, dùng biến `AIGUKA_ENABLE_HUMAN_TAKEOVER_ECHO=1`.

### Sửa luồng xin mẫu/xem ảnh
- Đưa nhánh `shouldSendCarousel()` lên trước flow khai thác nhu cầu để “Xin mẫu”, “xem thêm”, “gửi mẫu” luôn được xử lý ngay.
- Gom xử lý ảnh vào `handleProductMediaRequest()` có try/catch riêng.
- Nếu gửi ảnh/carousel lỗi, bot vẫn gửi fallback xin Zalo/SĐT thay vì im lặng.

### Sửa runtime
- Bổ sung hàm `isPriceRequest()` bị thiếu.
- Webhook catch không `return` làm dừng toàn bộ vòng xử lý event.

### Log chuẩn
- Thêm trace `AI-00-ECHO`, `AI-01-WEBHOOK`, `AI-02-STATE`, `AI-03-PHOTO-REQUEST`, `AI-05-PRODUCT-ROW`, `AI-06-PHOTO-RULE`, `AI-07-CALLING-OPENAI`, `AI-10-DONE`.

---

## v3.9.8 - Product Chat Integration & PHOTO_RULE hoàn chỉnh

### Product Chat
- Gắn Product Engine vào luồng hội thoại thật: khi khách xin mẫu/ảnh/catalog, bot tra Google Sheet để lấy nhóm sản phẩm và khoảng giá, sau đó đọc Google Drive theo cột Folder.
- Bot chỉ báo khoảng giá min → max, không báo giá cụ thể từng mẫu/model.
- Tích hợp Product Engine cho mọi nhóm sản phẩm có trong Google Sheet/Drive, không khóa riêng Fan.

### PHOTO_RULE V2.0
- 1–4 ảnh: gửi ảnh lẻ một lần, không gửi lặp nếu khách hỏi tiếp.
- Từ 5 ảnh trở lên: gửi Slide 1 từ 5–10 ảnh.
- Nếu khách yêu cầu xem tiếp: gửi Slide 2 gồm toàn bộ ảnh còn lại. Nếu còn hơn 10 ảnh, tự chia thành nhiều carousel trong cùng lượt Slide 2.
- Sau Slide 2: chèn câu mời để lại SĐT/Zalo vì Messenger dễ trôi tin và gửi nhiều ảnh nặng.
- Thêm Photo Memory để nhớ đã gửi Slide 1/Slide 2 theo từng nhóm sản phẩm.

### Google Drive
- Lọc trùng file ảnh khi Drive trả kết quả trùng lặp.

---

## v3.9.7
- Tắt tin nhắn fallback "hệ thống tư vấn tự động đang bận" khi server wakeup hoặc AI xử lý chậm.
- Khi lỗi/wakeup: chỉ log lỗi, không gửi tin nhắn chờ/bận cho khách; để bot trả lời muộn hoặc nhân viên/Pancake xử lý.
- Giữ nguyên Dashboard source lock và Product Engine V1 từ v3.9.6.


## v3.9.6 - Dashboard Source Fix + Product Engine V1

### Dashboard
- Hoàn thiện logic dropdown nguồn tin nhắn.
- Meta Direct hiển thị hội thoại theo Meta account/day Insights.
- Pancake hiển thị hội thoại theo dữ liệu Pancake/Webhook, không dùng chung số Meta.
- Đổi nhãn thẻ tổng quan: “Hội thoại Meta Account”, “Hội thoại Pancake” để tránh nhầm.

### Product Engine V1
- Thêm service đọc ảnh Google Drive theo `Folder` trong Google Sheet.
- Thêm endpoint `/product-drive-debug` để kiểm tra folder ảnh.
- Hỗ trợ biến môi trường `GOOGLE_DRIVE_PRODUCTS_ROOT_ID` và `GOOGLE_DRIVE_API_KEY`.
- Nếu chưa cấu hình Google Drive hoặc chưa có ảnh Drive, bot tự fallback về bộ ảnh mẫu cũ để không gãy tư vấn.

### PHOTO_RULE V2.0
- 1–4 ảnh: gửi toàn bộ ảnh lẻ.
- Từ 5 ảnh trở lên: gửi Slide 1 bằng carousel 5–10 ảnh.
- Nếu khách đòi xem tiếp: gửi Slide 2 gồm phần ảnh còn lại.
- Sau Slide 2: chèn câu xin SĐT/Zalo vì Messenger dễ trôi tin và gửi nhiều ảnh sẽ nặng.
- Bot nhớ trạng thái slide theo từng khách/từng nhóm ảnh để không gửi lại Slide 1 khi khách hỏi tiếp.

### Price Rule
- Tiếp tục khóa nguyên tắc chỉ báo khoảng giá min–max từ Google Sheet.
- Không báo giá cụ thể từng mẫu/model/ảnh trên Messenger.

---

## v3.9.5 - Dashboard Meta/Pancake source lock

### Dashboard
- Khóa logic Meta Direct: số hội thoại chỉ lấy từ Meta account/day Insights, không fallback sang webhook/Pancake.
- Sửa báo cáo tháng: nguồn Meta không còn lấy `max(webhook, Meta)` nên không bị lệch 17 → 21 hoặc 80.
- Header dashboard hiển thị rõ nguồn hiện tại và số hội thoại Meta Direct.
- Thêm endpoint `/dashboard-source-debug` để so sánh nhanh 3 nguồn: Meta, ad-level, Pancake/webhook.

### Quản lý release
- Từ bản này chỉ giữ một file `CHANGELOG.md` duy nhất.
- Không còn các file `CHANGELOG_3.x.x.md` rời rạc.

## v3.9.4 - Fix Meta daily conversation total
- Meta Direct tổng hội thoại theo Meta account/day để khớp Ads Manager và báo cáo tháng.
- SĐT/Zalo vẫn là dữ liệu bổ sung từ webhook/Pancake.

## v3.9.3 - Fix dashboard currentDataSource
- Sửa lỗi `currentDataSource is not defined` làm trắng dashboard.

## v3.9.2 - Fix Meta/Pancake source separation
- Tách nguồn hội thoại Meta Direct và Pancake/Webhook.
- Meta Direct không dùng số hội thoại Pancake làm tổng chính.

## v3.9.1 - Meta messages fallback fix
- Đọc thêm `actions` từ Meta Ads để lấy số hội thoại.
- Tăng khả năng map ad_id từ Pancake.

## v3.9.0 - Product Sheet Parser
- Đọc Google Sheet bảng giá theo cấu trúc showroom.
- Chỉ báo giá min → max, không báo giá từng mẫu.

## v3.8.4 - Product Sheet Price Range
- Thêm Product Sheet engine sơ bộ.

## v3.8.3 - Meta month messages/payment
- Dashboard tháng theo giờ Meta.
- Bổ sung dữ liệu tin nhắn/ngày, tài khoản, chi tiêu và thanh toán.

## v3.8.x - Dashboard source/UI fixes
- Sửa giao diện dashboard.
- Ẩn dropdown số dòng khi xem Meta.
- Cảnh báo Pancake lỗi.

## v3.7.x - Finance dashboard
- Dashboard tài chính nhiều tài khoản.
- Bổ sung cột tài khoản quảng cáo, chi tiêu, thẻ thanh toán.

## v3.6.x - Multi-account/timezone
- Hỗ trợ nhiều tài khoản quảng cáo.
- Hỗ trợ múi giờ tài khoản Meta.

## v3.5.x - Admin takeover robust
- Admin trả lời thủ công thì bot dừng ngay.
- Trong 10 phút nếu khách nhắn thêm, bot chỉ lưu không chen ngang.
- Sau 10 phút nếu admin không trả lời tiếp, bot đọc lại hội thoại rồi mới trả lời.

## AIGUKA 4.1.0 - Unified Meta + Pancake Timeline

- Tách session Supabase theo `source + page_id + sender_id + ad/post + ngày` thay vì gom vào hội thoại mở cuối cùng.
- Thêm endpoint `/pancake-sync-to-supabase` để đồng bộ hội thoại Pancake vào Supabase.
- Thêm parser mềm cho message Pancake để cố gắng lưu customer/admin/unknown message vào timeline.
- Thêm `role=admin`, `role=pancake_unknown` khi đồng bộ Pancake để audit không mất phần nhân viên xử lý.
- Thêm `/supabase-replay` để xem timeline theo `sender_id`.
- Thêm `/supabase-audit-summary` để kiểm tra nhanh tỷ lệ thiếu product/intent và phàn nàn gửi sai sản phẩm.
- Giữ nguyên Reply Engine/Hard Product Lock/Carousel fixes của 4.0.5.

## 4.2.1 - Drive Folder Mapping Fix
- Admin mapping không yêu cầu nhập từng link ảnh nữa.
- Cột `drive_folder` được dùng làm tên/thư mục ảnh Google Drive.
- Bot ưu tiên lấy ảnh từ Google Drive folder theo mapping quảng cáo, sau đó mới fallback sang `image_urls` cũ hoặc product media.
- HTML `/admin/ad-mapping.html` đổi nhãn thành “Tên thư mục ảnh Google Drive”.
