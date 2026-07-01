# Hướng dẫn deploy V5.2.3

## 1. Chạy SQL
Mở Supabase SQL Editor, chạy file:

```sql
database/SUPABASE_PATCH_V5_2_3.sql
```

## 2. Kiểm tra code
Trong Codespaces:

```bash
node -c src/app.js
```

## 3. Commit và push

```bash
git status
git add src/app.js src/sale-center/scheduleService.js public/ad-mapping.html database/SUPABASE_PATCH_V5_2_3.sql PATCH_NOTES_V5_2_3.md HUONG_DAN_DEPLOY_V5_2_3.md
git commit -m "AIGUKA V5.2.3 Sale Center Modular"
git push origin main
```

## 4. Test
Mở:

```text
https://manychat-openai-6oiq.onrender.com/admin/ad-mapping.html?v=523
```

Test các nút:
- Thêm khung giờ làm việc
- Thêm khung ngoài giờ
- Chọn ON/OFF/Hỗ trợ
- Lưu cấu hình
- Tải lại

## 5. Production
AIGUKA-Plus đã tắt Auto Deploy thì chỉ deploy thủ công khi bản test ổn.
