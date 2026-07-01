const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'module_settings.json');

const DEFAULT_MODULES = {
  message_log: { id: 'message_log', name: 'Message Log', enabled: true, critical: true, description: 'Lưu toàn bộ tin nhắn vào Supabase/local log.' },
  messenger_sync: { id: 'messenger_sync', name: 'Messenger Sync', enabled: true, critical: false, description: 'Đồng bộ hội thoại Messenger Graph.' },
  pancake_sync: { id: 'pancake_sync', name: 'Pancake Sync', enabled: true, critical: false, description: 'Đồng bộ dữ liệu Pancake.' },
  sale_lock: { id: 'sale_lock', name: 'Sale Lock', enabled: true, critical: true, description: 'Chặn bot cướp lời sale/admin.' },
  phone_detector: { id: 'phone_detector', name: 'Phone/Zalo Detector', enabled: true, critical: false, description: 'Nhận diện SĐT/Zalo từ Messenger/Pancake.' },
  product_detect: { id: 'product_detect', name: 'Product Detection', enabled: true, critical: false, description: 'Nhận diện sản phẩm từ tin khách và quảng cáo.' },
  ad_detect: { id: 'ad_detect', name: 'Ad Detection', enabled: true, critical: false, description: 'Nhận diện nguồn quảng cáo/post.' },
  policy_engine: { id: 'policy_engine', name: 'Policy Engine', enabled: true, critical: true, description: 'Luật chống bịa giá, chống gửi lặp, chống chen sale.' },
  ai_router: { id: 'ai_router', name: 'AI Router', enabled: true, critical: false, description: 'Chọn AI provider theo nhóm khách/sản phẩm.' },
  reply_bot_v5: { id: 'reply_bot_v5', name: 'V5 Reply Bot', enabled: true, critical: false, description: 'Module CSKH mới: 1 tin khách -> tối đa 1 phản hồi ngắn.' },
  legacy_reply_bot: { id: 'legacy_reply_bot', name: 'Legacy Reply Bot 4.x', enabled: false, critical: false, description: 'Workflow trả lời cũ 4.x; mặc định tắt để tránh lặp/chen sale.' },
  slide_engine: { id: 'slide_engine', name: 'Slide Engine', enabled: false, critical: false, description: 'Gửi slide/carousel; mặc định tắt trong V5 phase 1 để tránh gửi sai slide.' },
  followup: { id: 'followup', name: 'Follow-up', enabled: false, critical: false, description: 'Chăm sóc lại tự động.' },
  dashboard: { id: 'dashboard', name: 'Dashboard', enabled: true, critical: false, description: 'Dashboard báo cáo.' },
  debug: { id: 'debug', name: 'Debug API', enabled: true, critical: false, description: 'API kiểm tra dữ liệu/timeline.' }
};

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function loadRaw() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8').trim();
      if (raw) return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[MODULE_REGISTRY] load error:', e.message);
  }
  return {};
}

function saveRaw(data) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[MODULE_REGISTRY] save error:', e.message);
  }
}

function getModules() {
  const saved = loadRaw();
  const modules = clone(DEFAULT_MODULES);
  for (const [id, patch] of Object.entries(saved || {})) {
    modules[id] = { ...(modules[id] || { id, name: id }), ...patch, id };
  }
  return modules;
}

function isEnabled(id, fallback = false) {
  const modules = getModules();
  if (!modules[id]) return fallback;
  return modules[id].enabled !== false;
}

function setEnabled(id, enabled) {
  const modules = getModules();
  const base = modules[id] || { id, name: id, description: '' };
  const next = { ...base, enabled: enabled === true, updated_at: new Date().toISOString() };
  const saved = loadRaw();
  saved[id] = { ...(saved[id] || {}), enabled: next.enabled, updated_at: next.updated_at };
  saveRaw(saved);
  return next;
}

function health() {
  const modules = getModules();
  return Object.values(modules).map(m => ({
    id: m.id,
    name: m.name,
    enabled: m.enabled !== false,
    critical: Boolean(m.critical),
    description: m.description || '',
    status: m.enabled === false ? 'disabled' : 'running'
  }));
}

module.exports = { DEFAULT_MODULES, getModules, isEnabled, setEnabled, health };
