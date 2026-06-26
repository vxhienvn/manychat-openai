# AIGUKA 3.9.2 - Dashboard Meta Message Source Fix

## Fixed
- Meta Direct mode now uses Meta Insights `actions` as the only source for conversation/message counts.
- Webhook/Pancake data is used only to supplement phone/Zalo counts in Meta Direct mode.
- Pancake mode keeps Pancake/webhook conversation counts separate.
- Prevents dashboard from showing inflated conversation counts such as 80 when Ads Manager shows 17.
