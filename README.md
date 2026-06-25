# manychat-openai

## Hotfix admin takeover v3.5

- Admin trả lời thủ công: bot dừng ngay 10 phút.
- Khách nhắn trong 10 phút: bot chỉ lưu, không trả lời.
- Sau 10 phút nếu admin không trả lời tiếp: bot đọc lại 30 dòng hội thoại gần nhất rồi mới trả lời.
- Nếu admin trả lời tiếp: tự reset thêm 10 phút.
- Đã tăng độ chắc chắn bằng cách so sánh echo với các tin bot vừa gửi để tránh nhầm echo bot là admin.

## Dashboard tài chính v3.6.1

Biến môi trường hỗ trợ nhiều tài khoản quảng cáo:

```env
META_ACCESS_TOKEN=...
META_AD_ACCOUNT_ID=act_123
# hoặc nhiều tài khoản:
META_AD_ACCOUNT_IDS=act_123,act_456
# hoặc tự đọc tất cả tài khoản token truy cập được:
META_AUTO_AD_ACCOUNTS=true

META_ACCOUNT_TIMEZONE=America/Los_Angeles
META_SPEND_TAX_MULTIPLIER=1
META_CARD_LAST4=2417
META_ACCOUNT_CARD_MAP={"act_123":"2417","act_456":"1189"}
```

Webhook lưu thẻ thanh toán tự động từ SMS/email ngân hàng:

```bash
curl -X POST https://YOUR_DOMAIN/payment-webhook \
  -H "Content-Type: application/json" \
  -d '{"text":"Thẻ VCB Visa 452404...2417 sử dụng tại FACEBK *ABC số tiền 350.000 VND lúc 26-06-2026 10:39:00","account_id":"act_123"}'
```

Kiểm tra dữ liệu thẻ đã lưu: `/payment-debug`.
