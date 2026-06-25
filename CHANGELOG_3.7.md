# AIGUKA v3.7 - Finance Multi Account Dashboard

## Dashboard / Meta Ads
- Hỗ trợ nhiều tài khoản quảng cáo qua `META_AD_ACCOUNT_IDS`.
- Hỗ trợ tự đọc danh sách tài khoản quảng cáo token có quyền qua `META_AUTO_AD_ACCOUNTS=true`.
- `/dashboard` và `/dashboard-today` giữ lựa chọn giờ Pancake/VN hoặc giờ tài khoản quảng cáo.
- `/dashboard-meta-month` thêm cột tài khoản quảng cáo đang chạy và chi tiêu theo từng tài khoản.
- Bảng tháng gom chi tiêu theo ngày Meta, phù hợp tài khoản reset khoảng 14h Việt Nam khi dùng múi giờ Hoa Kỳ.

## Payment / Visa
- Thêm `META_ACCOUNT_CARD_MAP` để gán thẻ theo từng tài khoản QC.
- Thêm `/payment-webhook` để nhận nội dung SMS/email ngân hàng và tự đọc 4 số cuối thẻ.
- Thêm `/payment-debug` để kiểm tra các giao dịch đã ghi nhận.

## ENV gợi ý
```env
META_ACCESS_TOKEN=...
META_AUTO_AD_ACCOUNTS=true
META_ACCOUNT_TIMEZONE=America/Los_Angeles
META_SPEND_TAX_MULTIPLIER=1
META_ACCOUNT_CARD_MAP={"act_973318199015585":"2417","act_taikhoan2":"1189"}
```

Nếu không dùng auto account:
```env
META_AD_ACCOUNT_IDS=act_973318199015585,act_taikhoan2,act_taikhoan3
```

Webhook SMS mẫu:
```bash
curl -X POST https://your-domain/payment-webhook \
  -H "Content-Type: application/json" \
  -d '{"text":"The VCB Visa 452404...2417 su dung tai FACEBK so tien 496344 VND luc 25-06-2026 10:39:00"}'
```
