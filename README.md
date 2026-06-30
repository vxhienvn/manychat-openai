# AIGUKA 5.0.0 Modular Core Alpha

Mục tiêu bản này: tách nền module để sau này thêm/sửa/tắt từng chức năng mà không làm hỏng toàn hệ thống.

## Thay đổi chính

- Thêm Module Registry lưu tại `src/module_settings.json` khi bật/tắt module.
- Thêm API quản trị module:
  - `GET /api/modules`
  - `POST /api/modules/:moduleId` với body `{ "enabled": true/false }`
  - `POST /api/modules/:moduleId/toggle`
- Tách Reply Bot 4.x thành module `legacy_reply_bot`, mặc định OFF.
- Thêm `reply_bot_v5`, mặc định ON: CSKH mới, 1 tin khách -> tối đa 1 phản hồi ngắn.
- Slide Engine mặc định OFF để tránh gửi nhầm slide trong giai đoạn kiểm thử.
- Sale Lock, Policy Engine, Message Log, Sync giữ bật mặc định.

## Module mặc định

- `message_log`: ON
- `messenger_sync`: ON
- `pancake_sync`: ON
- `sale_lock`: ON
- `phone_detector`: ON
- `product_detect`: ON
- `ad_detect`: ON
- `policy_engine`: ON
- `ai_router`: ON
- `reply_bot_v5`: ON
- `legacy_reply_bot`: OFF
- `slide_engine`: OFF
- `followup`: OFF
- `dashboard`: ON
- `debug`: ON

## Cách test sau deploy

1. `GET /api/debug/health`
2. `GET /api/modules`
3. Bật công tắc tổng nếu muốn bot trả lời: `POST /api/bot-reply-switch { "enabled": true }`
4. Nhắn thử 1 câu ngắn. Kỳ vọng: chỉ 1 phản hồi, không gửi slide tự động.

## Ghi chú an toàn

Bản này chưa tích hợp Gemini/DeepSeek. Mục tiêu là làm nền module và khôi phục CSKH đơn giản, ổn định trước.
