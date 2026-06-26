# AIGUKA v3.9.0 - Product Sheet Parser theo cấu trúc thực tế showroom

## Mục tiêu
- Chuyển chatbot sang đọc bảng giá Google Sheet theo cấu trúc hiện tại của showroom.
- Áp dụng quy tắc: mọi sản phẩm chỉ báo khoảng giá min -> max, không báo giá chi tiết từng mẫu.
- Giữ vai trò AI là Pre-Sales: gửi vài mẫu nổi bật, khơi gợi nhu cầu, xin SĐT/Zalo, chuyển Sales.

## Cấu trúc Sheet được hỗ trợ
A. Folder
B. Tên sản phẩm
C. số cánh
D. màu
E. giá thấp nhất(VNĐ)
F. giá cao nhất(VNĐ)
G. giá vận chuyển/lắp đặt (đọc được nhưng không dùng để tư vấn)

## Thay đổi kỹ thuật
- Sửa parser Google Sheet để đọc đúng các cột tiếng Việt có hậu tố như `(VNĐ)`.
- Tự suy luận danh mục từ Folder: fan, bathroom, kitchen, lighting.
- Bỏ qua các dòng rỗng hoặc dòng không có path/giá.
- Sửa lỗi khi không tìm thấy product row nhưng khách hỏi giá.
- `/product-sheet-debug?force=1` dùng để ép đọc lại Google Sheet sau khi sửa bảng.

## Quy tắc bán hàng
- Bot không báo giá cụ thể từng model.
- Bot không gửi toàn bộ ảnh/catalog.
- Bot gửi tối đa vài mẫu nổi bật bằng gallery hiện có trong code.
- Muốn xem nhiều hơn hoặc báo chi tiết: xin SĐT/Zalo để Sales tư vấn.
