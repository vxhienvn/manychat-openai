# Hướng dẫn deploy AIGUKA 5.4.6

```bash
npm install
node --check src/app.js
node --check src/prompts/salesPrompt.js
```

Deploy:
```bash
git add .
git commit -m "AIGUKA 5.4.6 Message Gateway Trace"
git push origin main
```

Sau deploy kiểm tra log:
```bash
[MESSAGE_GATEWAY_SEND_REQUEST]
[MESSAGE_GATEWAY_SEND_RESULT]
[MESSAGE_GATEWAY_REWRITE]
[PENDING_BLOCKED_NOT_DONE]
```
