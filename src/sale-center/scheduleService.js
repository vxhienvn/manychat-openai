'use strict';

const DEFAULT_WORKING_CONFIG = Object.freeze({
  setting_key: 'default',
  timezone: 'Asia/Ho_Chi_Minh',
  is_open: true,
  bot_mode: 'support',
  work_start: '08:00',
  work_end: '22:00',
  staff_online_count: 1,
  admin_pause_minutes: 10,
  support_wait_minutes: 10,
  customer_wait_minutes: 5,
  outside_wait_minutes: 5,
  carousel_cooldown_minutes: 5,
  note: '',
  working_windows: [
    { enabled: true, name: 'Sáng', start: '08:00', end: '12:00', mode: 'off' },
    { enabled: true, name: 'Chiều', start: '13:30', end: '17:30', mode: 'off' }
  ],
  after_hours_windows: [
    { enabled: true, name: 'Tối', start: '17:30', end: '22:00', mode: 'support' },
    { enabled: true, name: 'Đêm', start: '22:00', end: '08:00', mode: 'support' }
  ],
  reply_windows: []
});

function parseClockMinutes(value = '08:00') {
  const m = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return 8 * 60;
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return hh * 60 + mm;
}

function minutesInWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return true;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

function normalizeBotMode(value = 'support') {
  const v = String(value || '').toLowerCase().trim();
  if (['on', 'off', 'support'].includes(v)) return v;
  if (['ho_tro', 'hỗ trợ', 'hotro'].includes(v)) return 'support';
  if (['bat', 'bật', 'true', 'yes'].includes(v)) return 'on';
  if (['tat', 'tắt', 'false', 'no'].includes(v)) return 'off';
  return 'support';
}

function normalizeWindow(raw = {}, fallback = {}) {
  return {
    enabled: raw.enabled === false ? false : true,
    name: String(raw.name || raw.label || fallback.name || '').trim(),
    label: String(raw.label || raw.name || fallback.name || '').trim(),
    start: String(raw.start || raw.from || fallback.start || '08:00').slice(0, 5),
    end: String(raw.end || raw.to || fallback.end || '22:00').slice(0, 5),
    mode: normalizeBotMode(raw.mode || fallback.mode || 'support')
  };
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
  }
  return [];
}

function normalizeWindowList(value, defaults = []) {
  const list = parseJsonList(value);
  const src = list.length ? list : defaults;
  return src.map((w, idx) => normalizeWindow(w, defaults[idx] || {}));
}

function mergeWindows(working = [], afterHours = []) {
  const a = normalizeWindowList(working, DEFAULT_WORKING_CONFIG.working_windows);
  const b = normalizeWindowList(afterHours, DEFAULT_WORKING_CONFIG.after_hours_windows);
  return [...a, ...b].map(w => ({
    enabled: w.enabled,
    start: w.start,
    end: w.end,
    mode: w.mode,
    label: w.label || w.name
  }));
}

function splitLegacyReplyWindows(replyWindows = []) {
  const list = normalizeWindowList(replyWindows, []);
  const working = [];
  const after = [];
  for (const w of list) {
    const label = `${w.name || w.label || ''}`.toLowerCase();
    if (label.includes('sale') || w.mode === 'off') working.push({ ...w, name: w.name || w.label || 'Giờ làm việc' });
    else after.push({ ...w, name: w.name || w.label || 'Ngoài giờ' });
  }
  return { working, after };
}

function normalizeConfig(raw = {}) {
  const legacy = splitLegacyReplyWindows(raw.reply_windows || raw.replyWindows || []);
  const workingDefaults = legacy.working.length ? legacy.working : DEFAULT_WORKING_CONFIG.working_windows;
  const afterDefaults = legacy.after.length ? legacy.after : DEFAULT_WORKING_CONFIG.after_hours_windows;
  const workingWindows = normalizeWindowList(raw.working_windows || raw.workingWindows, workingDefaults);
  const afterHoursWindows = normalizeWindowList(raw.after_hours_windows || raw.afterHoursWindows, afterDefaults);
  const cfg = {
    ...DEFAULT_WORKING_CONFIG,
    ...raw,
    is_open: raw.is_open === false ? false : true,
    holiday_mode: Boolean(raw.holiday_mode),
    bot_mode: normalizeBotMode(raw.bot_mode || raw.mode || DEFAULT_WORKING_CONFIG.bot_mode),
    work_start: String(raw.work_start || DEFAULT_WORKING_CONFIG.work_start).slice(0, 5),
    work_end: String(raw.work_end || DEFAULT_WORKING_CONFIG.work_end).slice(0, 5),
    staff_online_count: Math.max(0, Number(raw.staff_online_count || DEFAULT_WORKING_CONFIG.staff_online_count)),
    admin_pause_minutes: Math.max(1, Number(raw.admin_pause_minutes || DEFAULT_WORKING_CONFIG.admin_pause_minutes)),
    support_wait_minutes: Math.max(0, Number(raw.support_wait_minutes || raw.customer_wait_minutes || DEFAULT_WORKING_CONFIG.support_wait_minutes)),
    customer_wait_minutes: Math.max(0, Number(raw.customer_wait_minutes || DEFAULT_WORKING_CONFIG.customer_wait_minutes)),
    outside_wait_minutes: Math.max(0, Number(raw.outside_wait_minutes || raw.customer_wait_minutes || DEFAULT_WORKING_CONFIG.outside_wait_minutes)),
    carousel_cooldown_minutes: Math.max(1, Number(raw.carousel_cooldown_minutes || DEFAULT_WORKING_CONFIG.carousel_cooldown_minutes)),
    note: String(raw.note || ''),
    working_windows: workingWindows,
    after_hours_windows: afterHoursWindows
  };
  cfg.reply_windows = mergeWindows(cfg.working_windows, cfg.after_hours_windows);
  return cfg;
}

function getVietnamMinutes(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);
    const hour = Number((parts.find(p => p.type === 'hour') || {}).value || 0);
    const minute = Number((parts.find(p => p.type === 'minute') || {}).value || 0);
    return hour * 60 + minute;
  } catch (_) {
    const d = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

function resolveModeAt(config = {}, time = Date.now()) {
  const cfg = normalizeConfig(config);
  if (cfg.is_open === false) return { mode: 'off', matched: null, reason: 'global_bot_off' };
  if (cfg.holiday_mode) return { mode: cfg.bot_mode || 'support', matched: null, reason: 'holiday_mode' };
  const nowMin = getVietnamMinutes(new Date(time));
  const windows = mergeWindows(cfg.working_windows, cfg.after_hours_windows).filter(w => w.enabled !== false);
  const matched = windows.find(w => minutesInWindow(nowMin, parseClockMinutes(w.start), parseClockMinutes(w.end)));
  if (matched) return { mode: normalizeBotMode(matched.mode), matched, reason: 'matched_window' };
  return { mode: normalizeBotMode(cfg.bot_mode || 'support'), matched: null, reason: 'default_mode' };
}

function delayMsForMode(config = {}, mode = 'support') {
  const cfg = normalizeConfig(config);
  const m = normalizeBotMode(mode);
  if (m === 'on') return 0;
  if (m === 'off') return null;
  return Math.max(0, Number(cfg.support_wait_minutes || cfg.customer_wait_minutes || 10)) * 60 * 1000;
}

module.exports = {
  DEFAULT_WORKING_CONFIG,
  parseClockMinutes,
  minutesInWindow,
  normalizeBotMode,
  normalizeWindow,
  normalizeWindowList,
  mergeWindows,
  normalizeConfig,
  resolveModeAt,
  delayMsForMode,
  getVietnamMinutes
};
