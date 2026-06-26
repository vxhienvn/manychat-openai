# AIGUKA 3.8.4 - Product Sheet Price Range Engine

## Mục tiêu
- Kết nối Google Sheet bảng giá sản phẩm để bot lấy giá theo khoảng min -> max.
- Không báo giá cụ thể từng mẫu/model trên Messenger.
- Giữ vai trò bot là AI Pre-Sales: tạo hứng thú, gửi vài mẫu nổi bật, xin SĐT/Zalo để sale chốt.

## Thay đổi chính
1. Thêm `src/services/productSheetService.js`
   - Đọc Google Sheet CSV.
   - Cache dữ liệu 5 phút.
   - Chuẩn hóa cột: Danh mục, Nhóm sản phẩm, Đường dẫn, Giá thấp nhất, Giá cao nhất, Ghi chú.
   - Tự dò dòng phù hợp theo productType và nội dung khách hỏi.
   - Format giá dạng `khoảng X triệu đến Y triệu`.

2. Cập nhật `src/app.js`
   - Import Product Sheet Engine.
   - Thêm endpoint `/product-sheet-debug` để kiểm tra Sheet đọc được bao nhiêu dòng.
   - Khi khách hỏi giá: trả lời bằng khoảng giá min-max, sau đó xin SĐT/Zalo.
   - Khi khách xin ảnh/mẫu: intro có thể kèm khoảng giá nếu Sheet có dữ liệu.
   - Giới hạn gửi ảnh mẫu từ 4 xuống 3 ảnh.

3. Cập nhật prompt
   - Quy tắc giá áp dụng cho toàn bộ sản phẩm: chỉ nói khoảng giá min-max, không báo giá cụ thể từng mẫu.
   - Giá chi tiết, khuyến mại, vận chuyển/lắp đặt để sale báo trực tiếp.

## Biến môi trường mới
- `PRODUCT_SHEET_CSV_URL` optional. Nếu không đặt, hệ thống dùng link Sheet mặc định:
  `https://docs.google.com/spreadsheets/d/1HZH7ajJj5L2nZF77TP42vc60sLdBDgre0if8i1WFMj4/export?format=csv&gid=0`
- `PRODUCT_SHEET_CACHE_TTL_MS` optional, mặc định 300000 ms.

## Lưu ý triển khai
- Google Sheet phải để quyền xem công khai: Anyone with the link -> Viewer.
- Nếu Sheet chưa public hoặc đổi quyền, `/product-sheet-debug` sẽ báo lỗi Google Sheet HTTP.
- Ảnh hiện vẫn dùng gallery cũ trong code. Đường dẫn Drive trong Sheet phục vụ làm chỉ mục trước; để tự lấy ảnh từ Drive cần bước tiếp theo: Drive API hoặc thêm cột image_url công khai.
