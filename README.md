# AIGUKA v3.9.6

## Deploy

```bash
git add .
git commit -m "AIGUKA 3.9.6 - Dashboard source fix and Product Engine V1"
git push origin main
```

## Kiểm tra sau deploy

```text
/dashboard-today?time_basis=meta&data_source=meta&force=1
/dashboard-today?time_basis=pancake&data_source=pancake&force=1
/dashboard-source-debug?mode=today&time_basis=meta&data_source=meta&force=1
/product-sheet-debug?force=1
/product-drive-debug?folder=fan/10%20cánh/Gold&force=1
```

## Biến môi trường Google Drive tùy chọn

```text
GOOGLE_DRIVE_PRODUCTS_ROOT_ID=<folder_id_của thư mục Products>
GOOGLE_DRIVE_API_KEY=<Google API key có bật Drive API>
```

Nếu chưa cấu hình Google Drive, bot vẫn fallback về bộ ảnh mẫu cũ.
