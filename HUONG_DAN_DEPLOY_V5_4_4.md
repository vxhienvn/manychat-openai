# Hướng dẫn deploy AIGUKA 5.4.4

1. Giải nén và copy đè lên source hiện tại.
2. Cài package nếu cần:

```bash
npm install
```

3. Kiểm tra cú pháp:

```bash
node --check src/app.js
node --check src/prompts/salesPrompt.js
```

4. Deploy:

```bash
git add .
git commit -m "AIGUKA 5.4.4 event classifier conversation activity split"
git push origin main
```

5. Sau deploy, tìm log:

```text
[SUPABASE_STALE_UNANSWERED_SCAN]
[SUPABASE_STALE_UNANSWERED_SKIP_SAMPLES]
[SUPABASE_STALE_UNANSWERED_PENDING_CREATED]
[PENDING_REPLY_EXECUTE]
```

Nếu vẫn skipped, gửi lại dòng `SKIP_SAMPLES` mới.
