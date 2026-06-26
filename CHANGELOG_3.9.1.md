# AIGUKA 3.9.1 - Dashboard Meta Messages Fallback

## Fix chính
- Sửa Dashboard không hiện số tin nhắn theo quảng cáo dù Meta Ads có dữ liệu actions.
- Thêm đọc `actions` ở Meta ad insights và map thành `messagingCount`.
- Nếu Webhook/Pancake chưa map được hội thoại theo ad_id, bảng quảng cáo vẫn hiển thị số tin nhắn từ Meta Insights.
- SĐT/Zalo vẫn lấy từ dữ liệu hội thoại Pancake/Webhook khi có.
- Bổ sung parser ad_id linh hoạt cho payload Pancake để tăng khả năng khớp quảng cáo.
- Dữ liệu bảng quảng cáo dùng thêm Pancake làm nguồn bổ sung khi đang xem Meta Direct.

## Kiểm tra sau deploy
- Mở `/dashboard-today?time_basis=meta&data_source=meta`.
- Mở `/meta-debug?since=YYYY-MM-DD&until=YYYY-MM-DD` để kiểm tra ad spend.
- Mở `/internal-crm-debug` và `/pancake-review?limit=200&type=phone` để kiểm tra nguồn SĐT.
