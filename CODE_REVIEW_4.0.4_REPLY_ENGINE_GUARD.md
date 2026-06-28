# AIGUKA 4.0.4 - Reply Engine Guard

Base: AIGUKA 4.0.3 Product Scope + Durable Pending Queue.

## Mục tiêu
- Giữ nguyên Queue bền vững, Supabase logger và Product Scoped Slide Engine của 4.0.3.
- Sửa lớp Reply Engine để bot bớt trả lời máy móc, không lặp câu, không xin số quá dày, và xử lý đúng các intent phổ biến.

## Thay đổi chính
1. Lời chào đầu tiên luôn có lời mời để lại SĐT/Zalo mềm.
2. Lần khách rep tiếp theo không tự động xin số lại nếu chưa đủ tín hiệu mua.
3. Đến khoảng lượt khách thứ 3 hoặc lead score cao thì bot được xin lại SĐT/Zalo.
4. Thêm lead score cơ bản: giá, mua, ship, bảo hành, địa chỉ, chức năng.
5. Thêm Reply Guard trước khi gửi:
   - Chặn câu “cần kiểm tra đúng mẫu” máy móc.
   - Chống lặp câu trả lời gần giống trong lịch sử gần đây.
   - Chặn câu trả lời đồ bếp bị lẫn sen/lavabo/phòng tắm.
   - Không cho xin số khi chưa đến lượt nếu có thể trả lời trực tiếp.
6. Thêm trả lời rule-based cho:
   - Địa chỉ showroom.
   - Bảo hành.
   - Vận chuyển/lắp đặt.
   - Câu hỏi chung theo từng nhóm sản phẩm.
7. Thêm endpoint `/reply-engine-health` để kiểm tra nhanh intent/product/lead score.

## Không thay đổi
- Không bỏ JSON fallback.
- Không bỏ Supabase logger.
- Không bỏ pending_replies durable queue.
- Không bỏ product scope carousel của 4.0.3.
- Không thay đổi ENV Supabase.

## Test gợi ý sau deploy
- `/healthz`
- `/supabase-health`
- `/pending-replies-health`
- `/reply-engine-health`

Test hội thoại:
- “xin giá quạt”
- “báo giá rồi gửi số”
- “xem đồ bếp”
- “bồn cầu màu cam chức năng thế nào”
- “bảo hành bao lâu”
- “địa chỉ showroom ở đâu”
