# AIGUKA 3.8.1

## Dashboard UI
- Ẩn dropdown `Giới hạn hội thoại Pancake` khi chọn nguồn dữ liệu `Meta trực tiếp`.
- Đổi nhãn dropdown thành `Giới hạn hội thoại Pancake` để tránh hiểu nhầm Meta Direct bị giới hạn 100/300/500 hội thoại.
- Khi chọn `Pancake` hoặc `So sánh Meta/Pancake`, dropdown giới hạn Pancake vẫn hiển thị.
- Khi chọn `Meta trực tiếp`, dashboard hiển thị ghi chú: dữ liệu lấy từ Meta Webhook nội bộ, không giới hạn 100/300/500 hội thoại.

## Pancake health alert
- Thêm cảnh báo rõ ràng khi Pancake API lỗi hoặc không phản hồi.
- Nếu Pancake lỗi, dashboard vẫn chạy bằng dữ liệu Meta Direct và/hoặc cache Pancake gần nhất.
- Nếu Pancake kết nối bình thường, dashboard hiển thị trạng thái kết nối và thời điểm cập nhật.

## Deploy
```bash
git add .
git commit -m "Update AIGUKA v3.8.1 dashboard source UI"
git push origin main
```
