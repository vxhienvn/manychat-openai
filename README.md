# AIGUKA 4.1.1

Bản cập nhật trên nền 3.9.11, bổ sung nhận diện nhóm **tủ chậu gương / tủ lavabo** trong Bathroom và gửi mẫu từ Google Drive khi khách xin mẫu/xem thêm.

## Deploy

```bash
git add .
git commit -m "AIGUKA 4.1.1 - Add vanity cabinet mirror intent"
git push origin main
```

## Test nhanh

```text
Tủ chậu gương
Tủ lavabo có mẫu không
Cho xem mẫu tủ chậu
Gương lavabo giá bao nhiêu
Xin mẫu tủ chậu gương
```

## Ghi chú

- Bot map nhóm này vào `vanity`.
- Google Drive folder fallback: `Bathroom/tủ chậu gương`.
- Nếu Google Sheet chưa có dòng tủ chậu gương, bot vẫn có thể lấy ảnh từ Drive bằng fallback row.
- Nếu có dòng trong Google Sheet, Sheet vẫn được ưu tiên để lấy khoảng giá và path.

## AIGUKA 4.1.4 Debug API

Các endpoint đọc Supabase trực tiếp, chỉ đọc, không gửi tin nhắn:

- `GET /api/debug/health`
- `GET /api/debug/latest-conversations?limit=10`
- `GET /api/debug/conversation/:conversation_id`
- `GET /api/debug/search-messages?q=0973693677&limit=20`

Khuyến nghị đặt biến môi trường `DEBUG_API_KEY=<mật_khẩu_riêng>` trên Render/Railway. Khi đó gọi API kèm `?key=<mật_khẩu_riêng>` hoặc header `x-debug-key`.

Ví dụ:
`https://your-domain.com/api/debug/latest-conversations?limit=10&key=YOUR_DEBUG_KEY`
