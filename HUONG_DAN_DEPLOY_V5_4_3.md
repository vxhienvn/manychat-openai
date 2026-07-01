# Hướng dẫn deploy AIGUKA 5.4.3

```bash
npm install
node --check src/app.js
node --check src/prompts/salesPrompt.js
git add .
git commit -m "AIGUKA 5.4.3 Actor Identity Waiting Customer Detector"
git push origin main
```

Sau deploy, tìm log:

```text
[SUPABASE_STALE_UNANSWERED_SCAN]
[SUPABASE_STALE_UNANSWERED_PENDING_CREATED]
[PENDING_REPLY_EXECUTE]
```

Nếu vẫn skip, gửi log `[SUPABASE_STALE_UNANSWERED_SKIP_SAMPLES]` để đối chiếu actor_type.
