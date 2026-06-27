# CODE REVIEW 3.9.11

## Mục tiêu
Cập nhật từ nền 3.9.10, sửa logic hội thoại TBVS theo feedback thực tế từ Messenger.

## Đã kiểm tra
- `node --check src/app.js`: OK
- `node --check src/sales/salesEngine.js`: OK
- `node --check src/prompts/salesPrompt.js`: OK
- Giữ nguyên Dashboard, Product Engine, Google Sheet, Google Drive, PHOTO_RULE và các endpoint debug từ 3.9.10.

## Thay đổi chính
1. Bồn cầu thông minh là intent riêng `toilet`, không rơi vào `combo`.
2. Từ mơ hồ `bồn/bon/bồn này/bon này` sẽ hỏi lại: bồn cầu, bồn tắm hay lavabo/bồn rửa mặt.
3. Tin nhắn mở đầu/ký tự lạ như `Bắt đầu`, `hi`, `alo`, `.`, `?` sẽ hỏi khách quan tâm nhóm sản phẩm nào.
4. Trả lời nhu cầu bồn cầu thông minh tự nhiên hơn: AI, cảm ứng mở nắp, tự xả, tự phun rửa, sấy, UV, điều khiển giọng nói, rồi xin SĐT/Zalo.
5. Ưu tiên sản phẩm cụ thể trước, combo chỉ còn là nhóm tổng hợp.

## Checklist test sau deploy
- Nhắn: `Bồn cầu thông minh`
- Nhắn: `bệt bao nhiêu`
- Nhắn: `bon này bao tiền`
- Nhắn: `Bắt đầu`
- Nhắn: `Chậu giá bn`
