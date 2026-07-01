# AIGUKA V5.1.1 Hotfix

## Fixed
- Customer messages received while `sale_lock/admin takeover` is active are now saved and scheduled into `pending_replies` instead of being skipped forever.
- V5 now creates/updates one durable pending reply with reason `customer_during_admin_takeover_v5` and `due_at = bot_paused_until + 1s`.
- Pending worker now treats admin-takeover pending replies differently: after `bot_paused_until` expires, it can continue to process the latest customer message instead of cancelling forever because of historical Messenger sync/admin logs.
- Added clearer logs:
  - `[PENDING_REPLY_CREATED]`
  - `[PENDING_REPLY_EXECUTE]`
  - `[V5_REPLY] sale lock active; pending reply scheduled`

## Important
Run `SUPABASE_PATCH_V5_1_1.sql` once if your `messages` table is missing extended V5 columns.
