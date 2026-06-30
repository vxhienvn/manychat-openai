const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { loadProductRows, findBestProductRow, buildPriceRangeReply, buildProductIntroWithPrice } = require('./services/productSheetService');
const { listProductImagesByPath, debugDrivePath, driveReady } = require('./services/productDriveService');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/admin', express.static(path.join(__dirname, '..', 'public')));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ===== AIGUKA BOT REPLY MASTER SWITCH =====
// Default OFF for safety. Set BOT_REPLY_ENABLED=true in env or turn on from Admin UI.
let BOT_REPLY_ENABLED = String(process.env.BOT_REPLY_ENABLED || "false").toLowerCase() === "true";
function isBotReplyEnabled() {
    return BOT_REPLY_ENABLED === true;
}
function setBotReplyEnabled(value) {
    BOT_REPLY_ENABLED = value === true;
    console.log(`[BOT_REPLY_SWITCH] ${BOT_REPLY_ENABLED ? "ON" : "OFF"}`);
    return BOT_REPLY_ENABLED;
}

// ===== AIGUKA 4.0 LTS SUPABASE LOGGER =====
// Supabase dùng làm bộ nhớ dài hạn: lưu khách, phiên hội thoại, tin nhắn, bot events.
// Nếu Supabase lỗi, bot vẫn tiếp tục chạy bằng JSON local để tránh mất khách.
const SUPABASE_ENABLED = String(process.env.SUPABASE_ENABLED || "false").toLowerCase() === "true";
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";

// Public URL used for optional image proxy in Messenger carousel.
// Set AIGUKA_PUBLIC_URL=https://your-service.onrender.com on Render for best Pancake/Meta Suite compatibility.
const AIGUKA_PUBLIC_URL = String(process.env.AIGUKA_PUBLIC_URL || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const AIGUKA_IMAGE_PROXY_ENABLED = String(process.env.AIGUKA_IMAGE_PROXY_ENABLED || "true").toLowerCase() !== "false";


const HISTORY_FILE = path.join(__dirname, '..', 'conversations.json');
const STATE_FILE = path.join(__dirname, '..', 'customer_states.json');

// ===== AIGUKA 3.8 INTERNAL META CRM =====
// Lưu dữ liệu tin nhắn trực tiếp từ Meta Webhook để dashboard không phụ thuộc Pancake.
const MESSAGE_EVENTS_FILE = path.join(__dirname, '..', 'message_events.json');
const INTERNAL_CUSTOMERS_FILE = path.join(__dirname, '..', 'internal_customers.json');


function loadJsonFile(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8').trim();
            if (!raw) return fallback;
            return JSON.parse(raw);
        }
    } catch (error) {
        console.error("Load JSON error:", filePath, error.message);
    }
    return fallback;
}

function saveJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error("Save JSON error:", filePath, error.message);
    }
}

function supabaseIsReady() {
    return Boolean(SUPABASE_ENABLED && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseRequest(pathname, options = {}) {
    if (!supabaseIsReady()) return { skipped: true, reason: "supabase_disabled" };

    const url = `${SUPABASE_URL}/rest/v1/${pathname}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
            ...(options.headers || {})
        }
    });

    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }

    if (!response.ok) {
        throw new Error(`Supabase ${pathname} failed ${response.status}: ${raw}`);
    }
    return data;
}

async function supabaseUpsertCustomer({ senderId, pageId = "", phone = "", zalo = "", productGroup = "", source = "meta_webhook", contactInfo = null, name = "", avatarUrl = "" }) {
    if (!supabaseIsReady() || !senderId) return null;

    const detected = contactInfo || detectContactInfo([phone, zalo].filter(Boolean).join(" "));
    const finalPhone = phone || detected.phone || "";
    const finalZaloPhone = detected.zalo_phone || (/^0[0-9]{9}$/.test(String(zalo || "")) ? String(zalo) : "");
    const hasZalo = Boolean(finalZaloPhone || detected.has_zalo || (zalo && String(zalo).toLowerCase().includes("zalo")));

    const basePayload = {
        sender_id: String(senderId),
        page_id: pageId || null,
        name: name || null,
        avatar_url: avatarUrl || null,
        phone: finalPhone || null,
        // Cột zalo cũ chỉ lưu SỐ ZALO thật nếu khách nói rõ, không lưu chuỗi "zalo" nữa.
        zalo: finalZaloPhone || null,
        source,
        last_product_group: productGroup || null,
        phone_detected: Boolean(finalPhone || finalZaloPhone),
        updated_at: new Date().toISOString()
    };

    // Nếu DB đã được migrate 4.1.1 thì ghi thêm metadata liên hệ. Nếu chưa migrate, fallback payload cũ.
    const extendedPayload = {
        ...basePayload,
        zalo_phone: finalZaloPhone || null,
        has_zalo: hasZalo,
        contact_preference: detected.contact_preference || (finalZaloPhone ? "zalo" : finalPhone ? "phone" : null),
        zalo_qr_provided: Boolean(detected.zalo_qr_provided)
    };

    try {
        const rows = await supabaseRequest("customers?on_conflict=sender_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(extendedPayload)
        });
        return Array.isArray(rows) ? rows[0] : rows;
    } catch (error) {
        if (!String(error.message || "").includes("zalo_phone") && !String(error.message || "").includes("has_zalo") && !String(error.message || "").includes("contact_preference")) throw error;
        const rows = await supabaseRequest("customers?on_conflict=sender_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(basePayload)
        });
        return Array.isArray(rows) ? rows[0] : rows;
    }
}

function buildConversationSessionKey({ senderId = "", pageId = "", adId = "", postId = "", createdAt = null, source = "meta" }) {
    const d = createdAt ? new Date(createdAt) : new Date();
    const day = Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    const campaignKey = adId || postId || "direct";
    return `${source || "meta"}:${pageId || "page"}:${senderId}:${campaignKey}:${day}`;
}

async function supabaseGetOrCreateConversation({ customerId, senderId, pageId = "", adId = "", postId = "", productGroup = "", createdAt = null, source = "meta" }) {
    if (!supabaseIsReady() || !senderId) return null;

    // AIGUKA 4.1: không gom tất cả vào một conversation open cuối cùng nữa.
    // Tách phiên theo page + sender + ad/post + ngày + source để audit đúng từng phiên quảng cáo.
    const sessionKey = buildConversationSessionKey({ senderId, pageId, adId, postId, createdAt, source });
    const existing = await supabaseRequest(
        `conversations?session_key=eq.${encodeURIComponent(sessionKey)}&select=*&order=last_message_at.desc&limit=1`,
        { method: "GET" }
    );
    if (Array.isArray(existing) && existing[0]) {
        const conv = existing[0];
        await supabaseRequest(`conversations?id=eq.${conv.id}`, {
            method: "PATCH",
            body: JSON.stringify({
                customer_id: customerId || conv.customer_id || null,
                page_id: pageId || conv.page_id || null,
                ad_id: adId || conv.ad_id || null,
                post_id: postId || conv.post_id || null,
                product_group: productGroup || conv.product_group || null,
                last_message_at: createdAt || new Date().toISOString(),
                status: "open"
            })
        });
        return conv;
    }

    const inserted = await supabaseRequest("conversations", {
        method: "POST",
        body: JSON.stringify({
            customer_id: customerId || null,
            sender_id: String(senderId),
            page_id: pageId || null,
            session_key: sessionKey,
            ad_id: adId || null,
            post_id: postId || null,
            product_group: productGroup || null,
            status: "open",
            started_at: createdAt || new Date().toISOString(),
            last_message_at: createdAt || new Date().toISOString()
        })
    });
    return Array.isArray(inserted) ? inserted[0] : inserted;
}

function extractPostIdFromEvent(event = {}) {
    const ref = event?.referral || event?.message?.referral || event?.postback?.referral || {};
    return ref.post_id || ref.post?.id || ref.post?.post_id || event?.postback?.payload || "";
}

async function logMessageToSupabase({ event = null, senderId = "", pageId = "", role = "customer", text = "", messageType = "text", raw = null, productGroup = "", intent = "", attachmentUrl = "", source = "", externalMessageId = "" }) {
    if (!supabaseIsReady()) return { skipped: true };

    // 4.1.5 HOTFIX:
    // - Echo/page message: event.sender = Page, event.recipient = customer. Phải lưu theo customer sender_id.
    // - Customer message: event.sender = customer, event.recipient = Page.
    // Lỗi cũ làm admin/bot log vào conversation meta:page:... hoặc insert message fail âm thầm.
    const isEcho = Boolean(event?.message?.is_echo);
    const eventCustomerId = isEcho ? event?.recipient?.id : event?.sender?.id;
    const eventPageId = isEcho ? event?.sender?.id : event?.recipient?.id;
    const effectiveSenderId = String((isEcho && eventCustomerId) ? eventCustomerId : (senderId || eventCustomerId || ""));
    if (!effectiveSenderId) return { skipped: true, reason: "missing_sender_id" };

    try {
        const attachments = event?.message?.attachments || [];
        const contact = detectContactInfo(text, attachments);
        const referral = event ? getReferralInfoFromEvent(event) : {};
        const adId = referral.ad_id || "";
        const postId = extractPostIdFromEvent(event || {});
        const stateForLog = customerStates[effectiveSenderId] || {};
        const rawContextText = extractTextDeep(event || {}).join(" ");
        const inferredProduct = detectExplicitTopic([text, rawContextText].join(" ")) || stateForLog.productLock || stateForLog.lockedProduct || stateForLog.currentTopic || stateForLog.productType || "";
        const finalProduct = productGroup || toDbProductGroup(inferredProduct) || "";
        const finalIntent = intent || detectCustomerIntent(text);
        const finalPageId = pageId || eventPageId || stateForLog.lastPageId || PANCAKE_PAGE_ID || "";
        const messageCreatedAt = event?.timestamp ? new Date(Number(event.timestamp)).toISOString() : new Date().toISOString();
        const finalSource = source || raw?.source || (event ? (isEcho ? "meta_echo" : "meta_webhook") : "bot_runtime");
        const finalExternalMessageId = externalMessageId || event?.message?.mid || event?.postback?.mid || raw?.external_message_id || raw?.pancake_message_id || "";

        if (finalPageId && stateForLog && !stateForLog.lastPageId) {
            stateForLog.lastPageId = finalPageId;
        }
        if (finalProduct && stateForLog && !stateForLog.productLock) {
            stateForLog.productLock = finalProduct;
            stateForLog.lockedProduct = finalProduct;
            customerStates[effectiveSenderId] = stateForLog;
            saveCustomerStates(customerStates);
        }

        const customer = await supabaseUpsertCustomer({
            senderId: effectiveSenderId,
            pageId: finalPageId,
            phone: contact.phone || "",
            zalo: contact.zalo_phone || "",
            contactInfo: contact,
            productGroup: finalProduct,
            source: event ? "meta_webhook" : "bot_runtime"
        });

        const conversation = await supabaseGetOrCreateConversation({
            customerId: customer?.id,
            senderId: effectiveSenderId,
            pageId: finalPageId,
            adId,
            postId,
            productGroup: finalProduct,
            createdAt: messageCreatedAt
        });

        const mappedForLog = adId ? getMappedAdRow(adId) : null;
        const productItemForLog = detectProductItemFromText(text || rawContextText || "", finalProduct) || findProductItemByKey(stateForLog.productItemKey || mappedForLog?.product_item_key || "");
        const baseRaw = { ...(raw || event || {}), source: finalSource || undefined, external_message_id: finalExternalMessageId || undefined, contact_info: typeof contact !== "undefined" ? contact : undefined };
        const extendedPayload = {
            conversation_id: conversation?.id || null,
            customer_id: customer?.id || null,
            sender_id: effectiveSenderId,
            page_id: finalPageId || null,
            role,
            message_type: messageType || "text",
            text: String(text || ""),
            attachment_url: attachmentUrl || null,
            raw: baseRaw,
            ad_id: adId || null,
            post_id: postId || null,
            product_group: finalProduct || null,
            product_item_key: productItemForLog?.product_item_key || stateForLog.productItemKey || mappedForLog?.product_item_key || null,
            ad_name: mappedForLog?.ad_name || null,
            campaign_name: mappedForLog?.campaign_name || null,
            adset_name: mappedForLog?.adset_name || null,
            carousel_key: mappedForLog?.slide_key || null,
            drive_folder: productItemForLog?.drive_folder || mappedForLog?.drive_folder || null,
            fallback_reason: raw?.fallback_reason || raw?.reason || null,
            intent: finalIntent || null,
            source: finalSource || null,
            external_message_id: finalExternalMessageId || null,
            created_at: messageCreatedAt
        };

        // Fallback tối thiểu để không bao giờ mất message nếu DB chưa migrate đủ cột 4.x.
        const basicPayload = {
            conversation_id: conversation?.id || null,
            customer_id: customer?.id || null,
            sender_id: effectiveSenderId,
            page_id: finalPageId || null,
            role,
            message_type: messageType || "text",
            text: String(text || ""),
            attachment_url: attachmentUrl || null,
            raw: baseRaw,
            ad_id: adId || null,
            post_id: postId || null,
            product_group: finalProduct || null,
            intent: finalIntent || null,
            created_at: messageCreatedAt
        };

        let rows;
        try {
            rows = await supabaseRequest("messages", {
                method: "POST",
                body: JSON.stringify(extendedPayload)
            });
        } catch (insertError) {
            console.error("[SUPABASE_MESSAGE_EXTENDED_FAILED] retry basic payload:", insertError.message);
            rows = await supabaseRequest("messages", {
                method: "POST",
                body: JSON.stringify(basicPayload)
            });
        }
        return { ok: true, customer, conversation, message: Array.isArray(rows) ? rows[0] : rows };
    } catch (error) {
        console.error("Supabase logger error:", error.message);
        return { ok: false, error: error.message };
    }
}

async function logBotEventToSupabase({ senderId = "", eventType = "", eventData = {}, conversationId = null, customerId = null }) {
    if (!supabaseIsReady() || !senderId || !eventType) return { skipped: true };
    try {
        const customer = customerId ? { id: customerId } : await supabaseUpsertCustomer({ senderId });
        let conversation = conversationId ? { id: conversationId } : await supabaseGetOrCreateConversation({ customerId: customer?.id, senderId });
        await supabaseRequest("bot_events", {
            method: "POST",
            body: JSON.stringify({
                customer_id: customer?.id || null,
                conversation_id: conversation?.id || null,
                event_type: eventType,
                event_data: eventData || {}
            })
        });
        return { ok: true };
    } catch (error) {
        console.error("Supabase bot event error:", error.message);
        return { ok: false, error: error.message };
    }
}


// ===== AIGUKA 4.0.2 DURABLE PENDING REPLY QUEUE =====
// Lý do: setTimeout trong RAM sẽ mất khi Render sleep/restart.
// Vì vậy mọi lịch trả lời 5/10 phút phải được ghi vào Supabase.pending_replies.
let pendingReplyWorkerRunning = false;

async function supabaseGetCustomerAndConversationForSender(senderId, pageId = "") {
    const customer = await supabaseUpsertCustomer({ senderId, pageId });
    const conversation = await supabaseGetOrCreateConversation({
        customerId: customer?.id,
        senderId,
        pageId
    });
    return { customer, conversation };
}

async function getOpenPendingReplies(senderId) {
    if (!supabaseIsReady() || !senderId) return [];
    const rows = await supabaseRequest(
        `pending_replies?sender_id=eq.${encodeURIComponent(String(senderId))}&status=eq.pending&select=*&order=created_at.desc`,
        { method: "GET" }
    );
    return Array.isArray(rows) ? rows : [];
}

async function scheduleDurablePendingReply({ senderId, pageId = "", dueAtMs, reason = "customer_message" }) {
    if (!supabaseIsReady() || !senderId || !dueAtMs) return { skipped: true, reason: "supabase_disabled_or_missing_data" };

    try {
        const { customer, conversation } = await supabaseGetCustomerAndConversationForSender(senderId, pageId);
        const dueAtIso = new Date(dueAtMs).toISOString();
        const pendingRows = await getOpenPendingReplies(senderId);

        if (pendingRows.length > 0) {
            const keep = pendingRows[0];
            // Hủy các pending dư để mỗi khách chỉ còn 1 lịch trả lời.
            for (const extra of pendingRows.slice(1)) {
                await supabaseRequest(`pending_replies?id=eq.${extra.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ status: "cancelled", processed_at: new Date().toISOString(), reason: "deduped_by_new_message" })
                });
            }
            await supabaseRequest(`pending_replies?id=eq.${keep.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                    page_id: pageId || keep.page_id || null,
                    conversation_id: conversation?.id || keep.conversation_id || null,
                    customer_id: customer?.id || keep.customer_id || null,
                    due_at: dueAtIso,
                    reason,
                    status: "pending"
                })
            });
            return { ok: true, action: "updated", id: keep.id, due_at: dueAtIso };
        }

        const inserted = await supabaseRequest("pending_replies", {
            method: "POST",
            body: JSON.stringify({
                sender_id: String(senderId),
                page_id: pageId || null,
                conversation_id: conversation?.id || null,
                customer_id: customer?.id || null,
                due_at: dueAtIso,
                status: "pending",
                reason
            })
        });
        const row = Array.isArray(inserted) ? inserted[0] : inserted;
        return { ok: true, action: "inserted", id: row?.id, due_at: dueAtIso };
    } catch (error) {
        console.error("Durable pending schedule error:", senderId, error.message);
        return { ok: false, error: error.message };
    }
}

async function markPendingRepliesForSender(senderId, status, reason = "") {
    if (!supabaseIsReady() || !senderId) return { skipped: true };
    try {
        const rows = await getOpenPendingReplies(senderId);
        for (const row of rows) {
            await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status, reason: reason || row.reason || null, processed_at: new Date().toISOString() })
            });
        }
        return { ok: true, count: rows.length };
    } catch (error) {
        console.error("markPendingRepliesForSender error:", senderId, error.message);
        return { ok: false, error: error.message };
    }
}

async function processPendingReplyRow(row) {
    if (!row || !row.sender_id) return;
    const senderId = String(row.sender_id);

    try {
        await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "processing" })
        });

        const state = ensureCustomerState(senderId);
        const now = Date.now();
        const history = conversations[senderId] || [];
        const historyText = history.join(" ");
        const lastLine = String(history[history.length - 1] || "");

        if (state.hasContact || hasPhoneOrContact(historyText)) {
            state.hasContact = true;
            saveCustomerStates(customerStates);
            await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status: "cancelled", reason: "customer_has_contact", processed_at: new Date().toISOString() })
            });
            return;
        }

        if (state.humanTakeoverUntil && now < Number(state.humanTakeoverUntil)) {
            await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status: "pending", due_at: new Date(Number(state.humanTakeoverUntil) + 1000).toISOString(), reason: "admin_takeover_active" })
            });
            return;
        }

        if (!lastLine.startsWith("Khách:")) {
            await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status: "cancelled", reason: "last_message_not_customer", processed_at: new Date().toISOString() })
            });
            return;
        }

        if (hasAdminReplyAfterLastCustomer(history) || await hasSupabaseAdminAfterLastCustomer(senderId, getLastCustomerTimeFromHistory(history))) {
            cancelBotReplyBecauseSaleAnswered(senderId, "sale_answered_before_pending_due");
            await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status: "cancelled", reason: "sale_answered_before_due", processed_at: new Date().toISOString() })
            });
            return;
        }

        await processAiguka4Workflow(senderId, { recipient: { id: row.page_id || undefined } });
        await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "sent", processed_at: new Date().toISOString() })
        });
    } catch (error) {
        console.error("processPendingReplyRow error:", row?.sender_id, error.message);
        try {
            await supabaseRequest(`pending_replies?id=eq.${row.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status: "error", reason: String(error.message || error).slice(0, 500), processed_at: new Date().toISOString() })
            });
        } catch (_) {}
    }
}

async function processDuePendingReplies(limit = 20) {
    if (!supabaseIsReady()) return { skipped: true };
    if (pendingReplyWorkerRunning) return { skipped: true, reason: "worker_running" };

    pendingReplyWorkerRunning = true;
    try {
        const nowIso = new Date().toISOString();
        const rows = await supabaseRequest(
            `pending_replies?status=eq.pending&due_at=lte.${encodeURIComponent(nowIso)}&select=*&order=due_at.asc&limit=${Number(limit) || 20}`,
            { method: "GET" }
        );
        const list = Array.isArray(rows) ? rows : [];
        for (const row of list) {
            await processPendingReplyRow(row);
        }
        if (list.length) console.log(`Durable pending worker processed ${list.length} replies`);
        return { ok: true, count: list.length };
    } catch (error) {
        console.error("processDuePendingReplies error:", error.message);
        return { ok: false, error: error.message };
    } finally {
        pendingReplyWorkerRunning = false;
    }
}

function normalizeVietnamesePhone(raw) {
    const text = String(raw || "");
    let digits = text.replace(/[^0-9+]/g, "");
    if (digits.startsWith("+84")) digits = "0" + digits.slice(3);
    digits = digits.replace(/[^0-9]/g, "");
    if (digits.length > 10 && digits.startsWith("84")) digits = "0" + digits.slice(2);
    return digits;
}

function extractPhonesFromText(text) {
    const src = String(text || "");
    const matches = src.match(/(?:\+84|0)[0-9\s.\-]{8,13}/g) || [];
    const phones = [];
    for (const m of matches) {
        const n = normalizeVietnamesePhone(m);
        if (/^0[0-9]{9}$/.test(n) && !phones.includes(n)) phones.push(n);
    }
    return phones;
}

function detectZaloFromText(text) {
    const t = String(text || "").toLowerCase();
    return t.includes("zalo") || t.includes("za lo") || t.includes("zalo em") || t.includes("zalo anh") || t.includes("zalo chị") || t.includes("qua zalo") || t.includes("kết bạn zalo") || t.includes("ket ban zalo");
}

function extractZaloPhonesFromText(text) {
    const src = String(text || "");
    const phones = extractPhonesFromText(src);
    if (!phones.length) return [];
    const normalized = normalizeIntentText(src);
    const hasZaloWord = detectZaloFromText(src);
    if (!hasZaloWord) return [];

    // Chỉ gán số Zalo khi khách nói rõ Zalo kèm số.
    // Ví dụ: "Zalo: 098...", "gửi qua zalo số 033...", "kết bạn zalo 097...".
    const zaloContext = /(zalo|za\s*lo|ket ban zalo|kết bạn zalo|qua zalo|so zalo|số zalo).{0,25}(\+84|0)[0-9\s.\-]{8,13}/i;
    if (zaloContext.test(src) || phones.length === 1) return phones;
    return [];
}

function messageHasQrAttachment(text = "", attachments = []) {
    const msg = normalizeIntentText(text);
    const hasQrText = ["qr", "ma qr", "mã qr", "quet zalo", "quét zalo", "zalo qr"].some(w => msg.includes(normalizeIntentText(w)));
    const hasImage = Array.isArray(attachments) && attachments.some(a => String(a?.type || "").toLowerCase().includes("image") || a?.payload?.url);
    return Boolean(hasQrText || (hasImage && detectZaloFromText(text)));
}

function detectContactInfo(text = "", attachments = []) {
    const phones = extractPhonesFromText(text);
    const zaloPhones = extractZaloPhonesFromText(text);
    const hasZalo = detectZaloFromText(text) || zaloPhones.length > 0;
    const zaloQrProvided = messageHasQrAttachment(text, attachments);
    let contactPreference = null;
    if (zaloQrProvided) contactPreference = "zalo_qr";
    else if (zaloPhones.length) contactPreference = "zalo";
    else if (hasZalo && !phones.length) contactPreference = "zalo";
    else if (phones.length) contactPreference = "phone";
    return {
        phone: phones[0] || "",
        phones,
        zalo_phone: zaloPhones[0] || "",
        zaloPhones,
        has_zalo: hasZalo,
        contact_preference: contactPreference,
        zalo_qr_provided: zaloQrProvided
    };
}

function extractTextDeep(obj, maxDepth = 4, out = []) {
    if (!obj || maxDepth < 0) return out;
    if (typeof obj === "string") {
        if (obj.length < 500) out.push(obj);
        return out;
    }
    if (Array.isArray(obj)) {
        for (const item of obj) extractTextDeep(item, maxDepth - 1, out);
        return out;
    }
    if (typeof obj !== "object") return out;
    for (const [key, value] of Object.entries(obj)) {
        const k = String(key || "").toLowerCase();
        if (["text", "title", "subtitle", "body", "snippet", "ref", "source", "type", "post_id", "ad_id"].includes(k)) {
            extractTextDeep(value, maxDepth - 1, out);
        } else if (["referral", "postback", "message", "attachment", "attachments", "payload", "ad", "post", "metadata"].includes(k)) {
            extractTextDeep(value, maxDepth - 1, out);
        }
    }
    return out;
}

function makeInternalCustomerKey(pageId, senderId) {
    return `${pageId || "unknown_page"}:${senderId || "unknown_sender"}`;
}

function getReferralInfoFromEvent(event) {
    const ref = event?.referral || event?.message?.referral || event?.postback?.referral || {};
    return {
        source: ref.source || "",
        type: ref.type || "",
        ref: ref.ref || "",
        ad_id: ref.ad_id || ref.ad?.id || "",
        adgroup_id: ref.adgroup_id || "",
        campaign_id: ref.campaign_id || "",
        post_id: ref.post_id || ref.post?.id || ref.post?.post_id || ""
    };
}

function buildInternalTags({ text = "", state = {}, phones = [], hasZalo = false, direction = "customer" }) {
    const tags = new Set();
    const lower = String(text || "").toLowerCase();
    if (phones.length || state.hasContact) tags.add("Có SĐT");
    if (hasZalo) tags.add("Zalo");
    if (pancakeIsHotLead({ snippet: text })) tags.add("Khách nóng");
    const product = pancakeClassifyProduct(text);
    if (product && product !== "Khác") tags.add(product);
    if (direction === "admin") tags.add("Admin đã trả lời");
    if (state.stage === "HUMAN_HANDOVER") tags.add("Chuyển chuyên viên");
    if (state.phoneRejected || state.preferMessenger) tags.add("Không muốn gọi");
    return Array.from(tags);
}

function loadMessageEvents() {
    const data = loadJsonFile(MESSAGE_EVENTS_FILE, []);
    return Array.isArray(data) ? data : [];
}

function saveMessageEvents(events) {
    // Giữ tối đa 200.000 event trong file JSON để tránh phình quá nhanh trên Render.
    const max = Math.max(Number(process.env.MESSAGE_EVENTS_MAX || 200000), 10000);
    saveJsonFile(MESSAGE_EVENTS_FILE, events.slice(-max));
}

function loadInternalCustomers() {
    const data = loadJsonFile(INTERNAL_CUSTOMERS_FILE, {});
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function saveInternalCustomers(customers) {
    saveJsonFile(INTERNAL_CUSTOMERS_FILE, customers);
}

function recordInternalMessageEvent({ event = null, senderId = "", pageId = "", direction = "customer", text = "", state = null, extra = {} }) {
    try {
        const now = Date.now();
        const actualPageId = pageId || event?.recipient?.id || event?.page_id || "unknown_page";
        const actualSenderId = senderId || event?.sender?.id || event?.recipient?.id || "unknown_sender";
        const key = makeInternalCustomerKey(actualPageId, actualSenderId);
        const actualState = state || (customerStates[actualSenderId] || {});
        const phones = extractPhonesFromText(text);
        const hasZalo = detectZaloFromText(text);
        const referral = getReferralInfoFromEvent(event);
        const product = (actualState.currentTopic || actualState.productType) ? dashboardProductLabelFromTopic(actualState.currentTopic || actualState.productType) : pancakeClassifyProduct(text);
        const tags = buildInternalTags({ text, state: actualState, phones, hasZalo, direction });

        const messageEvent = {
            id: event?.message?.mid || `${actualPageId}-${actualSenderId}-${direction}-${now}`,
            customer_key: key,
            page_id: actualPageId,
            sender_id: actualSenderId,
            direction,
            text: String(text || ""),
            timestamp: now,
            created_at: new Date(now).toISOString(),
            phones,
            has_phone: phones.length > 0,
            has_zalo: hasZalo,
            product,
            tags,
            referral,
            ad_id: referral.ad_id || extra.ad_id || "",
            source: "meta_webhook",
            ...extra
        };

        const events = loadMessageEvents();
        if (!events.some(e => e.id === messageEvent.id && e.direction === messageEvent.direction)) {
            events.push(messageEvent);
            saveMessageEvents(events);
        }

        const customers = loadInternalCustomers();
        const old = customers[key] || {
            customer_key: key,
            page_id: actualPageId,
            sender_id: actualSenderId,
            name: actualSenderId,
            first_seen_at: messageEvent.created_at,
            message_count: 0,
            phones: [],
            tags: [],
            ad_ids: []
        };

        old.updated_at = messageEvent.created_at;
        old.last_message_at = messageEvent.created_at;
        old.last_message = messageEvent.text;
        old.last_direction = direction;
        old.product = product || old.product || "Khác";
        old.message_count = Number(old.message_count || 0) + (direction === "customer" ? 1 : 0);
        old.phones = Array.from(new Set([...(old.phones || []), ...phones]));
        old.has_phone = old.phones.length > 0 || Boolean(actualState.hasContact);
        old.has_zalo = Boolean(old.has_zalo || hasZalo);
        old.tags = Array.from(new Set([...(old.tags || []), ...tags, ...(old.has_phone ? ["Có SĐT"] : []), ...(old.has_zalo ? ["Zalo"] : [])]));
        if (messageEvent.ad_id) old.ad_ids = Array.from(new Set([...(old.ad_ids || []), messageEvent.ad_id]));
        old.referral = messageEvent.referral || old.referral || {};
        customers[key] = old;
        saveInternalCustomers(customers);
    } catch (error) {
        console.error("recordInternalMessageEvent error:", error.message);
    }
}

function dashboardProductLabelFromTopic(topic) {
    const t = String(topic || "").toLowerCase();
    if (t === "fan") return "Quạt";
    if (t === "kitchen") return "Bếp";
    if (t === "faucet") return "Thiết bị vệ sinh";
    if (t === "combo") return "Combo phòng tắm";
    if (t === "kitchen_bath") return "Combo phòng tắm";
    return "Khác";
}

function buildInternalRowsFromMetaWebhook(limit = 500) {
    const customers = Object.values(loadInternalCustomers());
    const rows = customers
        .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
        .slice(0, Math.max(Number(limit) || 500, 1))
        .map(c => ({
            name: c.name || c.sender_id || "Không rõ tên",
            conversation_id: c.customer_key,
            type: "meta_webhook",
            updated_at: c.updated_at,
            inserted_at: c.first_seen_at,
            message_count: c.message_count || 0,
            has_phone: Boolean(c.has_phone),
            phones: c.phones || [],
            product: c.product || pancakeClassifyProduct(c.last_message || ""),
            hot_lead: (c.tags || []).includes("Khách nóng") || pancakeIsHotLead({ snippet: c.last_message || "" }),
            tags: c.tags || [],
            snippet: c.last_message || "",
            ad_ids: c.ad_ids || [],
            ad_name: c.ad_name || c.latest_ad_name || "",
            ad_account_id: c.ad_account_id || "",
            ad_account_name: c.ad_account_name || "",
            campaign_name: c.campaign_name || "",
            adset_name: c.adset_name || "",
            page_id: c.page_id,
            sender_id: c.sender_id,
            source: "Meta trực tiếp"
        }));
    return rows;
}

function buildMetaPancakeCompare(metaRows, pancakeRows) {
    return {
        meta_total: metaRows.length,
        pancake_total: pancakeRows.length,
        meta_phone: metaRows.filter(x => x.has_phone).length,
        pancake_phone: pancakeRows.filter(x => x.has_phone).length,
        meta_zalo: metaRows.filter(x => (x.tags || []).includes("Zalo")).length,
        pancake_zalo: pancakeRows.filter(x => (x.tags || []).includes("Zalo")).length
    };
}

function loadConversations() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const raw = fs.readFileSync(HISTORY_FILE, 'utf8').trim();
            if (!raw) return {};
            return JSON.parse(raw);
        }
    } catch (error) {
        console.error("Load conversations error:", error);
    }
    return {};
}

function saveConversations(conversations) {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversations, null, 2));
    } catch (error) {
        console.error("Save conversations error:", error);
    }
}

function loadCustomerStates() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
            if (!raw) return {};
            return JSON.parse(raw);
        }
    } catch (error) {
        console.error("Load customer states error:", error);
    }
    return {};
}

function saveCustomerStates(customerStates) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(customerStates, null, 2));
    } catch (error) {
        console.error("Save customer states error:", error);
    }
}

function ensureCustomerState(senderId) {
    if (!customerStates[senderId]) {
        customerStates[senderId] = {};
    }

    const state = customerStates[senderId];

    if (!("productType" in state)) state.productType = null;
    if (!("currentTopic" in state)) state.currentTopic = state.productType || null;
    if (!("currentSubTopic" in state)) state.currentSubTopic = null;
    if (!Array.isArray(state.previousTopics)) state.previousTopics = [];
    if (!Array.isArray(state.carouselSent)) state.carouselSent = [];
    if (!("lastCustomerTime" in state)) state.lastCustomerTime = null;
    if (!("hasContact" in state)) state.hasContact = false;

    // followUp8hSent giữ lại để tương thích dữ liệu cũ
    if (!("followUp8hSent" in state)) state.followUp8hSent = false;

    // followUpOnceSent là cờ an toàn mới: chỉ chăm sóc tự động 1 lần duy nhất
    if (typeof state.followUpOnceSent === "undefined") {
        state.followUpOnceSent = Boolean(state.followUp8hSent);
    }

    if (!("lastFollowUpTime" in state)) state.lastFollowUpTime = null;
    if (!("lastCarouselTime" in state)) state.lastCarouselTime = null;
    if (!state.stage) state.stage = "DISCOVERY";
    if (typeof state.sampleSentCount === "undefined") state.sampleSentCount = 0;
    if (typeof state.lastPhoneAskTime === "undefined") state.lastPhoneAskTime = null;
    if (typeof state.lastSampleTime === "undefined") state.lastSampleTime = null;
    if (typeof state.lastIntent === "undefined") state.lastIntent = null;
    if (typeof state.askedPhone === "undefined") state.askedPhone = false;
    if (typeof state.phoneRejected === "undefined") state.phoneRejected = false;
    if (typeof state.preferMessenger === "undefined") state.preferMessenger = false;
    if (typeof state.humanTakeoverUntil === "undefined") state.humanTakeoverUntil = null;
    if (typeof state.lastAdminTime === "undefined") state.lastAdminTime = null;
    if (typeof state.pendingHumanCustomer === "undefined") state.pendingHumanCustomer = false;
    if (typeof state.consultAskCount === "undefined") state.consultAskCount = 0;
    if (typeof state.consultStartedAt === "undefined") state.consultStartedAt = null;
    if (typeof state.lastConsultTopic === "undefined") state.lastConsultTopic = null;

    return state;
}

function hasPhoneOrContact(text) {
    if (!text) return false;

    const normalized = text.toLowerCase();

    // Bắt số điện thoại Việt Nam: 0xxxxxxxxx hoặc +84xxxxxxxxx, có thể có dấu cách/chấm/gạch
    const phoneRegex = /(?:\+84|0)[0-9\s.-]{8,12}/;
    if (phoneRegex.test(normalized)) return true;

    if (
        normalized.includes("số của em") ||
        normalized.includes("sdt của em") ||
        normalized.includes("số điện thoại của em") ||
        normalized.includes("zalo của em") ||
        normalized.includes("zalo em") ||
        normalized.includes("zalo anh") ||
        normalized.includes("zalo chị") ||
        normalized.includes("gọi em") ||
        normalized.includes("goi em") ||
        normalized.includes("gọi anh") ||
        normalized.includes("goi anh") ||
        normalized.includes("liên hệ em") ||
        normalized.includes("lien he em") ||
        normalized.includes("đã cho số") ||
        normalized.includes("đã để lại số") ||
        normalized.includes("để lại số") ||
        normalized.includes("de lai so")
    ) {
        return true;
    }

    return false;
}

function buildFollowUpMessage(productType) {
    // Tin chăm sóc phải nhẹ, theo đúng chủ đề, không ép xin số để giảm rủi ro Meta đánh giá spam.
    if (productType === "fan") {
        return "Dạ em nhắn lại về mẫu quạt anh xem trước đó ạ. Nếu anh vẫn cần, em có thể gửi thêm vài mẫu cùng phân khúc theo diện tích phòng để anh tham khảo ngay tại đây. Anh muốn xem thêm dòng hiện đại hay dòng mạ vàng ạ?";
    }

    if (productType === "vanity") {
        return "Dạ em nhắn lại về nhóm tủ chậu gương/tủ lavabo anh xem trước đó ạ. Bên em còn nhiều mẫu phối đồng bộ cho phòng tắm. Anh muốn xem thêm mẫu cơ bản hay mẫu đẹp hơn một chút ạ?";
    }

    if (productType === "faucet") {
        return "Dạ em nhắn lại về nhóm sen vòi, lavabo, chậu rửa anh xem trước đó ạ. Bên em còn nhiều mẫu có thể phối đồng bộ cho phòng tắm. Anh muốn xem thêm dòng cơ bản hay dòng đẹp hơn một chút ạ?";
    }

    if (productType === "combo") {
        return "Dạ em nhắn lại về bộ thiết bị vệ sinh/phòng tắm anh xem trước đó ạ. Bên em có combo phối sẵn và combo tự chọn theo ngân sách. Anh muốn em gợi ý thêm nhóm mẫu phổ thông hay đẹp hơn một chút ạ?";
    }

    if (productType === "kitchen" || productType === "kitchen_bath") {
        return "Dạ em nhắn lại về nhóm thiết bị bếp/phòng tắm anh xem trước đó ạ. Nếu anh vẫn cần, em có thể gửi thêm mẫu theo ngân sách để anh tham khảo ngay tại đây. Anh muốn xem thêm nhóm nào trước ạ?";
    }

    return null;
}

async function checkFollowUpsOnStart() {
    console.log("Checking safe one-time follow-ups...");

    const now = Date.now();

    // Gửi 1 lần duy nhất trong khoảng 8h-23h sau tin nhắn cuối của khách
    const minDelay = 8 * 60 * 60 * 1000;
    const maxDelay = 23 * 60 * 60 * 1000;

    for (const senderId of Object.keys(conversations)) {
        try {
            const history = conversations[senderId];

            if (!Array.isArray(history) || history.length === 0) continue;

            const state = ensureCustomerState(senderId);
            const historyText = history.join(" ").toLowerCase();

            // Nếu đã có số/Zalo thì không chăm sóc tự động
            if (state.hasContact || hasPhoneOrContact(historyText)) {
                state.hasContact = true;
                saveCustomerStates(customerStates);
                continue;
            }

            // Chỉ gửi 1 lần duy nhất
            if (state.followUp8hSent || state.followUpOnceSent) continue;

            if (!state.lastCustomerTime) continue;

            const diff = now - Number(state.lastCustomerTime);

            // Chỉ gửi trong khung 8h-23h
            if (diff < minDelay || diff > maxDelay) continue;

            // Chỉ gửi nếu khách đã có ít nhất 2 tin nhắn
            const customerMessageCount = history.filter(line =>
                String(line).toLowerCase().startsWith("khách:")
            ).length;

            if (customerMessageCount < 2) {
                console.log("Skip follow-up, customer messages < 2:", senderId);
                continue;
            }

            // Chỉ gửi nếu xác định được đúng sản phẩm
            if (!state.productType && !state.currentTopic) {
                const detectedFromHistory = detectProductType("", historyText);
                if (detectedFromHistory) {
                    state.productType = detectedFromHistory;
                    state.currentTopic = detectedFromHistory;
                } else {
                    console.log("Skip follow-up, unknown product type:", senderId);
                    continue;
                }
            }

            const followText = buildFollowUpMessage(state.currentTopic || state.productType);

            if (!followText) {
                console.log("Skip follow-up, no message for type:", senderId, state.productType);
                continue;
            }

            await sendMessage(senderId, followText);

            history.push(`Bot chăm sóc 1 lần (${state.currentTopic || state.productType}): ${followText} | TIME:${now} | PRODUCT:${state.currentTopic || state.productType}`);
            conversations[senderId] = history.slice(-60);

            // Đánh dấu đã gửi để không bao giờ gửi lại lần 2
            state.followUp8hSent = true;
            state.followUpOnceSent = true;
            state.lastFollowUpTime = now;

            saveConversations(conversations);
            saveCustomerStates(customerStates);

            console.log("Safe one-time follow-up sent:", senderId, state.currentTopic || state.productType);
        } catch (error) {
            console.error("Follow-up error for sender:", senderId, error);
        }
    }
}


const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

const conversations = loadConversations();
const customerStates = loadCustomerStates();
const processedMessages = new Set();
const carouselLocks = new Set();

// Khi admin vào trả lời thủ công, bot tạm dừng 10 phút.
// Nếu trong 10 phút khách nhắn thêm mà admin không trả lời tiếp, bot sẽ đọc lại hội thoại và trả lời sau khi hết 10 phút.
const humanTakeoverTimers = new Map();
// AIGUKA 4.0: mỗi khách chỉ có một timer chờ bot trả lời. Khách nhắn tiếp => reset timer.
const customerReplyTimers = new Map();

app.get('/', (req, res) => {
    res.send('Server OK - AIGUKA 4.1.0 Unified Timeline');
});

app.get('/healthz', (req, res) => {
    res.status(200).json({
        ok: true,
        service: 'AIGUKA',
        version: '4.1.1-Full-Pancake-Session-Contact-Fix',
        time: new Date().toISOString()
    });
});


app.get('/image-proxy', async (req, res) => {
    const url = String(req.query.u || "");
    if (!/^https:\/\//i.test(url)) return res.status(400).send("Bad image url");
    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 AIGUKA Image Proxy",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            }
        });
        if (!response.ok) throw new Error(`source ${response.status}`);
        const type = response.headers.get("content-type") || "image/jpeg";
        const buf = Buffer.from(await response.arrayBuffer());
        res.setHeader("Content-Type", type.startsWith("image/") ? type : "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.send(buf);
    } catch (error) {
        // 1x1 transparent gif fallback: prevents broken requests from crashing the bot.
        const fallback = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Cache-Control", "public, max-age=300");
        return res.send(fallback);
    }
});

app.get('/supabase-health', async (req, res) => {
    if (!supabaseIsReady()) {
        return res.status(200).json({ ok: false, enabled: SUPABASE_ENABLED, error: 'Supabase env is missing or disabled' });
    }
    try {
        const result = await supabaseRequest('product_groups?select=id,name&limit=3', { method: 'GET' });
        return res.json({ ok: true, enabled: true, url: SUPABASE_URL, sample: result });
    } catch (error) {
        return res.status(500).json({ ok: false, enabled: true, error: error.message });
    }
});




// ===== AIGUKA DEBUG API =====
// Read-only API để ChatGPT/Admin đọc trực tiếp hội thoại từ Supabase, không cần export CSV.
// Bảo mật: nếu đặt DEBUG_API_KEY trong env thì phải gửi ?key=... hoặc header x-debug-key.
function aigukaDebugAllowed(req) {
    const key = String(process.env.DEBUG_API_KEY || '').trim();
    if (!key) return true; // Không đặt key thì cho phép để tránh làm hỏng deploy cũ. Nên đặt key khi public.
    const provided = String(req.query.key || req.headers['x-debug-key'] || '').trim();
    return provided && provided === key;
}

function requireAigukaDebugAccess(req, res) {
    if (aigukaDebugAllowed(req)) return true;
    res.status(401).json({ ok: false, error: 'DEBUG_API_KEY_REQUIRED_OR_INVALID' });
    return false;
}

function clampDebugLimit(value, fallback = 10, max = 50) {
    const n = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

function compactDebugMessage(row, includeRaw = false) {
    if (!row) return row;
    const out = {
        id: row.id,
        conversation_id: row.conversation_id,
        sender_id: row.sender_id,
        role: row.role,
        message_type: row.message_type,
        text: row.text,
        attachment_url: row.attachment_url,
        ad_id: row.ad_id,
        post_id: row.post_id,
        product_group: row.product_group,
        intent: row.intent,
        source: row.source || row.raw?.source || null,
        external_message_id: row.external_message_id || row.raw?.external_message_id || row.raw?.pancake_message_id || null,
        created_at: row.created_at
    };
    if (includeRaw) out.raw = row.raw;
    return out;
}

function groupMessagesByConversation(messages) {
    const map = new Map();
    for (const m of Array.isArray(messages) ? messages : []) {
        const key = String(m.conversation_id || '');
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(m);
    }
    return map;
}

async function debugFetchMessagesForConversationIds(ids, includeRaw = false, perConversationLimit = 200) {
    const cleanIds = (ids || []).map(String).filter(Boolean);
    if (!cleanIds.length) return [];
    // Supabase/PostgREST in.(uuid1,uuid2). ids do DB sinh UUID nên không chứa ký tự nguy hiểm.
    const inList = cleanIds.map(id => id.replace(/[^a-zA-Z0-9_-]/g, '')).join(',');
    const select = '*';
    const limit = Math.min(cleanIds.length * perConversationLimit, 2000);
    return await supabaseRequest(`messages?conversation_id=in.(${inList})&select=${select}&order=created_at.asc&limit=${limit}`, { method: 'GET' });
}

app.get('/api/debug/health', async (req, res) => {
    if (!requireAigukaDebugAccess(req, res)) return;
    res.json({
        ok: true,
        name: 'AIGUKA Debug API',
        version: '4.1.4-debug-api',
        supabase_ready: supabaseIsReady(),
        reply_enabled: isBotReplyEnabled(),
        debug_key_required: Boolean(String(process.env.DEBUG_API_KEY || '').trim()),
        endpoints: [
            'GET /api/debug/latest-conversations?limit=10&include_raw=false',
            'GET /api/debug/conversation/:conversation_id?include_raw=false',
            'GET /api/debug/search-messages?q=0973693677&limit=20&include_raw=false'
        ]
    });
});

app.get('/api/debug/latest-conversations', async (req, res) => {
    if (!requireAigukaDebugAccess(req, res)) return;
    if (!supabaseIsReady()) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_READY' });
    try {
        const limit = clampDebugLimit(req.query.limit, 10, 50);
        const includeRaw = String(req.query.include_raw || 'false').toLowerCase() === 'true';
        const conversations = await supabaseRequest(
            `conversations?select=*&order=last_message_at.desc&limit=${limit}`,
            { method: 'GET' }
        );
        const ids = (conversations || []).map(c => c.id).filter(Boolean);
        const messages = await debugFetchMessagesForConversationIds(ids, includeRaw, 200);
        const byConv = groupMessagesByConversation(messages);
        const data = (conversations || []).map(c => ({
            conversation: c,
            message_count: (byConv.get(String(c.id)) || []).length,
            messages: (byConv.get(String(c.id)) || []).map(m => compactDebugMessage(m, includeRaw))
        }));
        res.json({ ok: true, limit, count: data.length, data });
    } catch (error) {
        console.error('[DEBUG_API] latest-conversations error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/debug/conversation/:conversationId', async (req, res) => {
    if (!requireAigukaDebugAccess(req, res)) return;
    if (!supabaseIsReady()) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_READY' });
    try {
        const conversationId = String(req.params.conversationId || '').trim();
        const includeRaw = String(req.query.include_raw || 'false').toLowerCase() === 'true';
        const conversations = await supabaseRequest(
            `conversations?id=eq.${encodeURIComponent(conversationId)}&select=*&limit=1`,
            { method: 'GET' }
        );
        const messages = await debugFetchMessagesForConversationIds([conversationId], includeRaw, 500);
        res.json({
            ok: true,
            conversation: Array.isArray(conversations) ? conversations[0] || null : null,
            message_count: Array.isArray(messages) ? messages.length : 0,
            messages: (messages || []).map(m => compactDebugMessage(m, includeRaw))
        });
    } catch (error) {
        console.error('[DEBUG_API] conversation error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/debug/search-messages', async (req, res) => {
    if (!requireAigukaDebugAccess(req, res)) return;
    if (!supabaseIsReady()) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_READY' });
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
        const limit = clampDebugLimit(req.query.limit, 20, 100);
        const includeRaw = String(req.query.include_raw || 'false').toLowerCase() === 'true';
        const select = '*';
        const encoded = encodeURIComponent(`*${q.replace(/[%*]/g, '')}*`);
        const messages = await supabaseRequest(
            `messages?text=ilike.${encoded}&select=${select}&order=created_at.desc&limit=${limit}`,
            { method: 'GET' }
        );
        const ids = [...new Set((messages || []).map(m => m.conversation_id).filter(Boolean))];
        const convIn = ids.map(id => String(id).replace(/[^a-zA-Z0-9_-]/g, '')).join(',');
        let conversations = [];
        if (convIn) {
            conversations = await supabaseRequest(`conversations?id=in.(${convIn})&select=*`, { method: 'GET' });
        }
        res.json({
            ok: true,
            q,
            count: Array.isArray(messages) ? messages.length : 0,
            conversations,
            messages: (messages || []).map(m => compactDebugMessage(m, includeRaw))
        });
    } catch (error) {
        console.error('[DEBUG_API] search-messages error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/pending-replies-health', async (req, res) => {
    if (!supabaseIsReady()) {
        return res.status(200).json({ ok: false, enabled: SUPABASE_ENABLED, error: 'Supabase env is missing or disabled' });
    }
    try {
        const pending = await supabaseRequest('pending_replies?status=eq.pending&select=id,sender_id,due_at,reason&order=due_at.asc&limit=10', { method: 'GET' });
        const due = await processDuePendingReplies(10);
        return res.json({ ok: true, pending_sample: pending, processed_due: due });
    } catch (error) {
        return res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/reply-engine-health', (req, res) => {
    const samples = [
        { text: 'xin giá quạt', product: detectExplicitTopic('xin giá quạt'), intent: detectCustomerIntent('xin giá quạt'), score: leadScoreForMessage('xin giá quạt') },
        { text: 'báo giá rồi gửi số', product: detectExplicitTopic('báo giá rồi gửi số'), intent: detectCustomerIntent('báo giá rồi gửi số'), score: leadScoreForMessage('báo giá rồi gửi số') },
        { text: 'xem đồ bếp', product: detectExplicitTopic('xem đồ bếp'), intent: detectCustomerIntent('xem đồ bếp'), score: leadScoreForMessage('xem đồ bếp') },
        { text: 'bồn cầu màu cam chức năng thế nào', product: detectExplicitTopic('bồn cầu màu cam chức năng thế nào'), intent: detectCustomerIntent('bồn cầu màu cam chức năng thế nào'), score: leadScoreForMessage('bồn cầu màu cam chức năng thế nào') }
    ];
    res.json({ ok: true, version: '4.1.1-Full-Pancake-Session-Contact-Fix', samples });
});

app.get('/product-sheet-debug', async (req, res) => {
    try {
        const rows = await loadProductRows({ force: req.query.force === '1' });
        res.json({
            success: true,
            count: rows.length,
            rows: rows.slice(0, 20)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/product-drive-debug', async (req, res) => {
    try {
        const folder = String(req.query.folder || req.query.path || "");
        const result = await debugDrivePath(folder, { force: req.query.force === '1' });
        res.json({ success: true, version: "3.9.10", ...result });
    } catch (error) {
        res.status(500).json({ success: false, version: "3.9.10", error: error.message });
    }
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Webhook verified');
        return res.status(200).send(challenge);
    }

    console.log('Webhook verification failed');
    return res.sendStatus(403);
});

function normalizeIntentText(text = "") {
    return String(text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d");
}

function isAmbiguousBonQuery(message) {
    const raw = String(message || "").toLowerCase().trim();
    const msg = normalizeIntentText(raw).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!msg) return false;

    const clearToilet = ["bon cau", "bon ve sinh", "bet", "toilet", "wc", "cau thong minh"].some(w => msg.includes(w));
    const clearBath = ["bon tam", "bathtub", "massage"].some(w => msg.includes(w));
    const clearLavabo = ["lavabo", "bon rua mat", "chau rua mat", "chau lavabo"].some(w => msg.includes(w));
    if (clearToilet || clearBath || clearLavabo) return false;

    return /^(bon|bon nay|bon kia|bon do|bon gia|bon bao nhieu|bon nay bao nhieu|bon nay gia bao nhieu|bồn|bồn này|bồn kia|bồn đó)$/i.test(raw) ||
        /^(bon|bồn)\s+(nay|này|kia|do|đó|gia|giá|bn|bao nhieu|bao nhiêu)(\s|$)/i.test(raw);
}

function buildAmbiguousBonReply() {
    return "Dạ anh/chị đang hỏi bồn cầu, bồn tắm hay lavabo/bồn rửa mặt ạ? Anh/chị nhắn rõ giúp em để em gửi đúng mẫu và khoảng giá nhé 😊";
}

function isStarterOrUnclearMessage(message) {
    const raw = String(message || "").trim();
    const msg = normalizeIntentText(raw).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!msg) return true;
    const starters = ["bat dau", "start", "hi", "hello", "helo", "alo", "a lo", "chao", "xin chao", "ok", "o ke"];
    if (starters.includes(msg)) return true;
    if (raw.length <= 3 && !/[a-zA-ZÀ-ỹ0-9]/.test(raw.replace(/[?.!,]/g, ""))) return true;
    if ([".", "..", "...", "?", "??", "???", "!", "👍"].includes(raw)) return true;
    return false;
}

function buildStarterProductAsk() {
    return buildUnknownProductClarifyReply();
}

function buildSmartToiletReply() {
    return "Dạ bên em có nhiều mẫu bồn cầu thông minh, bồn cầu AI từ phổ thông đến cao cấp ạ. Một số dòng có cảm ứng tự mở nắp, tự xả, tự phun rửa, sấy khô, tia UV khử khuẩn, điều khiển từ xa và điều khiển giọng nói. Anh/chị cho em xin SĐT hoặc Zalo, bên em gửi mẫu phù hợp kèm khoảng giá và tư vấn cụ thể cho mình nhé.";
}

function buildSmartVanityReply() {
    return "Dạ bên em có nhiều mẫu tủ chậu gương/tủ lavabo cho phòng tắm ạ: có dòng tủ chậu treo tường, tủ chậu liền gương, tủ chậu lavabo hiện đại và mẫu phối đồng bộ theo không gian. Anh/chị muốn xem mẫu cơ bản hay mẫu đẹp hơn chút ạ? Nếu tiện anh/chị để lại SĐT/Zalo, bên em gửi thêm mẫu thực tế kèm khoảng giá cho mình nhé.";
}

function detectExplicitTopic(message) {
    const msg = normalizeIntentText(message || "");

    if (isAmbiguousBonQuery(message)) return null;

    const toiletWords = [
        "bon cau", "bon cau thong minh", "bon cau ai", "cau thong minh",
        "bon ve sinh", "bet", "toilet", "wc", "lien khoi", "tu dong xa",
        "xa nuoc", "xả nước", "nut bam", "nút bấm", "nap rua", "nắp rửa",
        "tu phun", "tu rua", "uv", "khu khuan", "dieu khien giong noi"
    ];
    if (toiletWords.some(word => msg.includes(word))) return "toilet";

    const fanWords = [
        "quạt", "quat", "quạt trần", "quat tran", "quạt đèn", "quat den",
        "guka", "5 cánh", "5 canh", "8 cánh", "8 canh", "10 cánh", "10 canh",
        "55w", "65w", "70w", "90w", "đèn không", "den khong", "đèn nhẹ", "den nhe",
        "không lòe", "khong loe"
    ];

    const vanityWords = [
        "tu chau guong", "tu chau", "tu lavabo", "bo tu chau", "bo tu lavabo",
        "tu nha tam", "tu phong tam", "tu guong", "guong tu",
        "guong lavabo", "guong nha tam", "guong phong tam", "chau guong",
        "tủ chậu gương", "tủ chậu", "tủ lavabo", "bộ tủ chậu", "bộ tủ lavabo",
        "tủ nhà tắm", "tủ phòng tắm", "tủ gương", "gương tủ",
        "gương lavabo", "gương nhà tắm", "gương phòng tắm", "chậu gương"
    ];

    const kitchenWords = [
        "bếp", "bep", "đồ bếp", "do bep", "thiết bị bếp", "thiet bi bep",
        "bếp từ", "bep tu", "hút mùi", "hut mui", "máy hút mùi", "may hut mui",
        "chậu rửa bát", "chau rua bat", "vòi bếp", "voi bep", "tủ bếp", "tu bep"
    ];

    const faucetWords = [
        "lavabo", "chậu lavabo", "chau lavabo",
        "sen", "sen tắm", "sen tam",
        "vòi", "voi", "vòi rửa", "voi rua",
        "chậu rửa", "chau rua"
    ];

    const bathWords = [
        "combo", "phòng tắm", "phong tam", "nhà tắm", "nha tam",
        "nhà vệ sinh", "nha ve sinh", "thiết bị vệ sinh", "thiet bi ve sinh",
        "tbvs", "bồn tắm", "bon tam", "gạch", "gach"
    ];

    const hasVanity = vanityWords.some(word => msg.includes(word));
    const hasKitchen = kitchenWords.some(word => msg.includes(word));
    const hasBath = bathWords.some(word => msg.includes(word));
    const hasFan = fanWords.some(word => msg.includes(word));
    const hasFaucet = faucetWords.some(word => msg.includes(word));

    if (hasKitchen && hasBath) return "kitchen_bath";

    // Ưu tiên sản phẩm cụ thể khi khách hỏi rõ
    if (hasFan) return "fan";
    if (hasVanity) return "vanity";
    if (hasKitchen) return "kitchen";
    if (hasFaucet) return "faucet";
    if (hasBath) return "combo";

    return null;
}

function detectProductType(customerMessage, historyText) {
    const msg = (customerMessage || "").toLowerCase();
    const history = (historyText || "").toLowerCase();

    const explicit = detectExplicitTopic(msg);
    if (explicit) return explicit;

    const askImageWords = [
        "gửi ảnh", "gui anh", "xin ảnh", "xin anh",
        "xem ảnh", "xem anh", "cho ảnh", "cho anh",
        "xem mẫu", "xem mau", "cho xem", "gửi mẫu", "gui mau",
        "xin mẫu", "xin mau", "cho mẫu", "cho mau", "xem",
        "catalog", "catalogue", "hình", "hinh", "báo giá", "bao gia"
    ];

    const isAsking = askImageWords.some(word => msg.includes(word)) || !msg.trim();

    // Nếu khách chỉ nói "cho xem thêm", "báo giá", "không nghe máy"... thì dùng lịch sử/chủ đề cũ
    if (isAsking) {
        const fromHistory = detectExplicitTopic(history);
        if (fromHistory) return fromHistory;
    }

    return null;
}

function shouldSendCarousel(customerMessage) {
    const msg = (customerMessage || "").toLowerCase();

    // Chỉ kích hoạt carousel khi khách thật sự xin ảnh/mẫu/catalog.
    // Không dùng từ đơn "anh" hoặc "ảnh" vì rất dễ nhầm với đại từ xưng hô.
    const words = [
        "gửi ảnh", "gui anh",
        "xin ảnh", "xin anh",
        "xem ảnh", "xem anh",
        "cho ảnh", "cho anh",
        "xem mẫu", "xem mau",
        "cho xem", "gửi mẫu", "gui mau",
        "xin mẫu", "xin mau",
        "cho mẫu", "cho mau",
        "gửi các mẫu", "gui cac mau",
        "gửi mẫu và giá", "gui mau va gia",
        "xem thêm mẫu", "xem them mau",
        "catalog", "catalogue",
        "hình ảnh", "hinh anh",
        "hình thật", "hinh that",
        "ảnh thật", "anh that",
        "hình thực tế", "hinh thuc te",
        "ảnh thực tế", "anh thuc te",
        "khách vừa gửi", "khach vua gui",
        "cần tư vấn mẫu này", "can tu van mau nay"
    ];

    return words.some(word => msg.includes(word));
}

function isDontCallMessage(message) {
    const msg = (message || "").toLowerCase();

    return [
        "không nghe", "khong nghe", "ko nghe", "k nghe",
        "không tiện nghe", "khong tien nghe", "không tiện gọi", "khong tien goi",
        "đang làm", "dang lam", "đang bận", "dang ban", "bận", "ban",
        "shop ồn", "ồn không nghe", "on khong nghe",
        "nhắn ở đây", "nhan o day", "gửi qua đây", "gui qua day",
        "nhắn qua đây", "nhan qua day", "messenger", "inbox"
    ].some(word => msg.includes(word));
}

function buildDontCallReply(productType) {
    if (productType === "fan") {
        return "Dạ không sao anh, em tư vấn luôn qua Messenger cho tiện ạ. Với quạt đèn không lòe loẹt, anh nên chọn mẫu ánh sáng vàng nhẹ hoặc trung tính, kiểu hiện đại đơn giản. Anh muốn em gửi vài mẫu quạt đúng kiểu đó bên dưới không ạ?";
    }

    if (productType === "faucet") {
        return "Dạ không sao anh, em tư vấn qua Messenger cũng được ạ. Với sen vòi/lavabo/chậu rửa, anh muốn xem mẫu cơ bản dễ dùng hay mẫu đẹp đồng bộ hơn để em gửi đúng nhóm ạ?";
    }

    if (productType === "combo") {
        return "Dạ không sao anh, em tư vấn qua Messenger cũng được ạ. Với thiết bị vệ sinh/phòng tắm, bên em có combo cơ bản, trung cấp và cao cấp. Anh muốn xem mẫu theo tầm giá nào để em gửi đúng hơn ạ?";
    }

    if (productType === "kitchen" || productType === "kitchen_bath") {
        return "Dạ không sao anh, em tư vấn qua Messenger cũng được ạ. Anh muốn xem mẫu bếp, chậu rửa hay combo phòng tắm để em gửi đúng nhóm ạ?";
    }

    return "Dạ không sao anh, em tư vấn qua Messenger cũng được ạ. Anh đang muốn xem thêm mẫu hoặc báo giá nhóm sản phẩm nào để em gửi đúng hơn ạ?";
}

function buildCarouselIntro(productType) {
    if (productType === "fan") {
        return "Dạ em gửi anh một số mẫu quạt bán chạy bên dưới để anh tham khảo nhé.";
    }

    if (productType === "vanity") {
        return "Dạ em gửi anh/chị một số mẫu tủ chậu gương/tủ lavabo nổi bật bên dưới để tham khảo nhé.";
    }

    if (productType === "faucet") {
        return "Dạ em gửi anh một số mẫu sen vòi, lavabo, chậu rửa phổ biến bên dưới để anh tham khảo nhé.";
    }

    if (productType === "combo") {
        return "Dạ em gửi anh một số mẫu combo thiết bị vệ sinh/phòng tắm phổ biến bên dưới để anh tham khảo nhé.";
    }

    if (productType === "kitchen") {
        return "Dạ em gửi anh một số mẫu thiết bị bếp, chậu rửa, vòi bếp bên dưới để anh tham khảo nhé.";
    }

    if (productType === "kitchen_bath") {
        return "Dạ em gửi anh một số mẫu cho cả khu bếp và phòng tắm bên dưới để anh tham khảo nhé.";
    }

    return "Dạ em gửi anh một số mẫu bán chạy bên dưới để anh tham khảo nhé.";
}

function buildCarouselClose(productType) {
    return buildPostSlideReply(productType, isOfficeHoursVN());
}

function getCustomerMessageFromEvent(event) {
    if (!event.message) return null;

    if (event.message.text && event.message.text.trim()) {
        return event.message.text.trim();
    }

    if (Array.isArray(event.message.attachments) && event.message.attachments.length > 0) {
        const types = event.message.attachments.map(a => a.type).join(", ");
        return `Khách vừa gửi ${types || "ảnh/tệp"} sản phẩm và cần tư vấn mẫu này`;
    }

    return null;
}

async function getAIReply(history) {
    const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Bạn là nhân viên tư vấn bán hàng của Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc.

VAI TRÒ:
- Xưng hô chỉ gọi khách là anh hoặc là chị chứ không gọi anh/chị này nọ. Nếu khách xưng anh trước thì gọi anh, nếu khách xưng chị trước thì gọi chị, nếu khách không xưng hô thì gọi anh/chị tùy trường hợp.
- Trả lời như nhân viên bán hàng thật.
- Không nói mình là AI nếu khách không hỏi.
- Trả lời ngắn gọn, tự nhiên, không lan man.
- Phải đọc kỹ lịch sử hội thoại trước khi trả lời.
- Tuyệt đối không hỏi lại thông tin khách đã nói.
- Không được chuyển nhầm sản phẩm. Nếu lịch sử đang nói về bồn tắm thì chỉ nói bồn tắm; đang nói quạt thì chỉ nói quạt.
- Nếu khách đã để lại số điện thoại/Zalo thì không xin lại, chỉ cảm ơn và xác nhận nhân viên sẽ liên hệ.

THÔNG TIN DOANH NGHIỆP:
- Tổng kho phân phối toàn miền Bắc.
- Bán nhiều thương hiệu khác nhau.
- Có thương hiệu riêng GUKA.
- Showroom: 254 Phố Keo, Gia Lâm, Hà Nội.
- Hotline: 0973693677.

SẢN PHẨM:
- Quạt trần, quạt đèn, quạt mạ vàng.
- Bồn cầu thông minh, sen tắm, lavabo, thiết bị vệ sinh.
- Combo phòng tắm, thiết bị bếp, gạch đá ốp lát, nội thất, bồn tắm.

THÔNG TIN QUẠT GUKA:
- Có dòng cơ bản, trung cấp, cao cấp.
- Bản cao cấp có động cơ Nhật/Ý nhập khẩu công suất cao 75W trở lên.
- Động cơ khoảng 65W phù hợp phòng khoảng 25-30m2.
- Dòng 70-90W thường phù hợp phòng lớn hơn hoặc nhu cầu gió mạnh hơn.
- Quạt 10 cánh sải cánh thường 1,9m, động cơ tầm 70W trở lên.
- Quạt 8 cánh sải cánh thường xấp xỉ 1,7m, động cơ tầm 65W.
- THAM KHẢO QUẠT GUKA

- Giá quạt chỉ được nói theo khoảng giá min-max khi có dữ liệu. Không báo giá cụ thể từng mẫu trong Messenger.
- Nếu cần giá chi tiết, luôn xin SĐT/Zalo để sale tư vấn trực tiếp.

COMBO / THIẾT BỊ:
- Combo có loại phối sẵn và loại tự chọn theo nhu cầu.
- Thiết bị vệ sinh, phòng tắm, gạch đá, nội thất nên mời khách qua showroom xem thực tế.
- Có hỗ trợ chi phí khách đến showroom theo chương trình.
- Có hỗ trợ vận chuyển khi mua hàng theo chính sách.

QUY TẮC ƯU TIÊN TUYỆT ĐỐI:
- Nếu khách đã để lại SĐT/Zalo: không hỏi thêm nhu cầu, không hỏi ngân sách, không xin số lại, không tư vấn dài. Chỉ xác nhận đã nhận số và báo chuyên viên sẽ gọi/gửi catalogue qua Zalo vì Messenger quảng cáo dễ trôi tin.
- Nếu khách đã có SĐT/Zalo nhưng vẫn hỏi thêm: trả lời trực tiếp tối đa 1-2 câu rồi lái về chuyên viên gọi lại.
- Nếu khách hỏi hãng/thương hiệu/xuất xứ: phải trả lời trực tiếp trước. Thiết bị vệ sinh có TOTO, INAX, Viglacera, Huge, Caesar... và thương hiệu riêng GUKA. Không được hỏi ngược "mua combo hay mua lẻ" trước khi trả lời hãng.
- Không được nói "em gửi ảnh/mẫu bên dưới", "em gửi catalogue" nếu server chưa chắc chắn gửi được ảnh ngay sau đó.
- Riêng bồn cầu/bệt hiện chưa có bộ ảnh tự động riêng: không hứa gửi ảnh bên dưới, hãy xin SĐT/Zalo để chuyên viên gửi đúng mẫu.
- Bồn cầu thông minh/bồn cầu AI/bệt/toilet/WC là nhóm riêng, không được trả lời thành combo phòng tắm. Trả lời ngắn về tính năng: cảm ứng tự mở nắp, tự xả, tự phun rửa, sấy khô, UV khử khuẩn, điều khiển từ xa/giọng nói; sau đó xin SĐT/Zalo để gửi đúng mẫu và khoảng giá.
- Tủ chậu gương/tủ lavabo/bộ tủ chậu/gương lavabo là nhóm riêng trong Bathroom, không được hiểu nhầm thành tủ bếp hoặc combo phòng tắm. Khi khách hỏi nhóm này, nói có nhiều mẫu tủ chậu treo tường, tủ chậu liền gương, tủ lavabo hiện đại; nếu khách xin mẫu/xem thêm thì gửi ảnh từ thư mục Bathroom/tủ chậu gương theo PHOTO_RULE.
- Nếu khách chỉ nói mơ hồ "bồn", "bon", "bồn này", "bon này" thì phải hỏi lại: đang hỏi bồn cầu, bồn tắm hay lavabo/bồn rửa mặt; tuyệt đối không tự đoán là bồn tắm.
- Nếu khách chỉ nhắn "Bắt đầu", "hi", "alo", ".", "?" hoặc ký tự khó hiểu: hỏi khách đang quan tâm quạt, thiết bị vệ sinh, bồn cầu, lavabo, sen vòi, bồn tắm, nhà bếp, gạch men hay đèn trang trí; có thể mời để lại SĐT/Zalo tư vấn nhanh.

QUY TẮC:
- Ưu tiên tư vấn có giá trị trước.
- Nếu khách hỏi giá, xin mẫu, xin ảnh, hỏi "mẫu này bao nhiêu", "gửi mẫu", "cho xem mẫu": chỉ được nói khoảng giá thấp nhất đến cao nhất nếu có dữ liệu chắc chắn, tuyệt đối không báo giá cụ thể từng mẫu, sau đó xin SĐT/Zalo để sale tư vấn.
- Nếu khách muốn xem trên Messenger hoặc nói "gửi qua đây", "xem trên này", "cho xem ảnh", "xin mẫu", "xem mẫu", "tư vấn", "tv", "xin thông tin", "gửi mẫu": nói ngắn gọn rằng em gửi một số mẫu bán chạy bên dưới để anh/chị tham khảo. Server sẽ gửi carousel sau câu trả lời, không cần tự mô tả quá dài.
- Không được nói "em gửi mẫu" nếu không có ý định gửi mẫu/slide ngay sau đó.
- Không được tự nói lại nhiều lần rằng đã gửi mẫu; nếu đã nói gửi mẫu thì chỉ nói một lần ngắn gọn.
- Không bịa giá. Bất kể sản phẩm nào cũng chỉ nói khoảng giá min-max; không báo giá cụ thể từng model/mẫu/ảnh. Nếu chưa có dữ liệu giá thì xin SĐT/Zalo để chuyên viên báo lại.
- Giá trên Messenger chỉ là khoảng giá tham khảo min-max để khách biết phân khúc. Giá chi tiết, khuyến mại, vận chuyển/lắp đặt để sale báo trực tiếp sau khi có SĐT/Zalo.
- Nếu khách hỏi cả bếp và phòng tắm thì giữ đúng nhu cầu tổng hợp, không tự thu hẹp thành riêng sen vòi/bếp/quạt.
- Không xin số điện thoại/Zalo quá 1 lần trong 3 lượt trả lời liên tiếp.
- Nếu khách đã bỏ qua yêu cầu xin số thì tiếp tục tư vấn, không xin lại ngay.
- Nếu khách nhắn ký tự khó hiểu hoặc phàn nàn ảnh/video lỗi: hỏi lại ngắn gọn cần xem mẫu nào, không ép xin số ngay.
- Tối đa 4 câu, tối đa 80 từ.
- Sau khi gửi ảnh/slide, chỉ nói: "Đây là một số mẫu bán chạy để anh tham khảo, bên em còn nhiều mẫu khác nữa." Sau đó hỏi nhu cầu tiếp theo.
- Luôn kết thúc bằng câu hỏi tự nhiên.



QUY TẮC XIN SĐT/ZALO THEO NHU CẦU:
- Khi khách hỏi rõ sản phẩm/cần tư vấn như quạt, thiết bị vệ sinh, bồn cầu, tủ, chậu rửa, sen vòi, lavabo, thiết bị bếp... thì ưu tiên xin SĐT/Zalo để gửi mẫu và tư vấn nhanh.
- Nếu khách chưa cho số thì khai thác nhu cầu bằng 1 câu hỏi ngắn, tối đa 2 câu hỏi.
- Khi khách đã trả lời lại nhu cầu thì xin SĐT/Zalo lần nữa để gửi mẫu/báo giá/tư vấn chi tiết.
- Không hỏi lan man quá 2 lượt trước khi xin số.

QUY TẮC CHỐNG TRẢ LỜI LUNG TUNG:
- Không được tự nhận có sản phẩm/giá nếu thông tin không có trong dữ liệu. Nếu không chắc, nói cần kiểm tra lại và xin SĐT/Zalo hoặc ảnh sản phẩm.
- KHÔNG được nói "em gửi mẫu bên dưới", "em gửi ảnh", "đợi em gửi" trừ khi khách vừa xin ảnh/mẫu rõ ràng. Việc gửi ảnh do server xử lý.
- Nếu khách hỏi đến sản phẩm ngoài các nhóm chính, hãy trả lời ngắn: cần kiểm tra lại mẫu/tồn kho để báo chính xác, xin SĐT/Zalo hoặc ảnh sản phẩm.
- Sau 2-3 lượt khách hỏi giá/mua/xem mẫu mà chưa có số, cần xin SĐT/Zalo nhẹ nhàng.

QUY TẮC GIỮ NGỮ CẢNH:
- Nếu lịch sử đang tư vấn quạt/đèn/quạt đèn, và khách chỉ nói không tiện nghe máy, đang bận, đang làm, shop ồn, hoặc nhắn qua đây thì vẫn tiếp tục tư vấn quạt. Không được hỏi lại khách cần quạt hay thiết bị vệ sinh.
- Chỉ đổi sang thiết bị vệ sinh/phòng tắm/lavabo/sen vòi khi khách chủ động hỏi rõ sản phẩm đó.
- Nếu server đã gửi carousel thì không tự nói thêm "vui lòng đợi"; chỉ nói ngắn gọn rằng mẫu ở bên dưới.
- Nếu khách xin ảnh/xin mẫu/catalog, server sẽ xử lý theo thứ tự: tin giới thiệu ngắn -> slide ảnh -> tin chốt xin SĐT/Zalo. Bot không cần tự lặp lại quy trình này.

LỊCH SỬ HỘI THOẠI:
${history}
        `
    });

    return response.output_text || "Dạ anh cho em xin thêm nhu cầu cụ thể để bên em tư vấn mẫu phù hợp ạ.";
}


function isBotHardPaused(senderId) {
    const st = customerStates[String(senderId)] || {};
    return Boolean(st.humanTakeoverUntil && Date.now() < Number(st.humanTakeoverUntil));
}

function normalizeOutboundTextForDedupe(text = "") {
    return normalizeIntentText(text).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isDuplicateBotOutbound(senderId, text = "") {
    const st = customerStates[String(senderId)] || {};
    const now = Date.now();
    const normalized = normalizeOutboundTextForDedupe(text);
    const lastNormalized = normalizeOutboundTextForDedupe(st.lastBotReply || "");

    // Chặn tin giống hệt hoặc gần giống nhau trong 30 phút.
    if (normalized && lastNormalized && st.lastBotReplyTime && now - Number(st.lastBotReplyTime) < 30 * 60 * 1000) {
        if (normalized === lastNormalized) return true;
        if (normalized.length > 35 && lastNormalized.length > 35 && (normalized.includes(lastNormalized) || lastNormalized.includes(normalized))) return true;
    }

    // Chặn việc xin SĐT/Zalo dồn dập. Sale đã xin số rồi thì bot càng không được xin lại.
    if (containsPhoneAsk(text) && st.lastPhoneAskTime && now - Number(st.lastPhoneAskTime) < 20 * 60 * 1000) {
        return true;
    }

    return false;
}


function logBlockedBotReply(senderId, text, reason = "blocked", messageType = "text", extraRaw = {}) {
    try {
        const st = customerStates[String(senderId)] || {};
        logMessageToSupabase({
            senderId,
            pageId: st.lastPageId || "",
            role: "bot_blocked",
            text: String(text || ""),
            messageType,
            productGroup: toDbProductGroup(st.currentTopic || st.productType || st.lockedProduct || "") || "",
            intent: "bot_reply_blocked",
            source: "bot_guard",
            raw: { source: "bot_guard", blocked_reason: reason, ...extraRaw }
        }).catch(err => console.error("Supabase blocked bot log error:", err.message));
    } catch (err) {
        console.error("Blocked bot logger error:", err.message);
    }
}

async function sendMessage(senderId, text, options = {}) {
    const stateForGuard = ensureCustomerState(senderId);

    // MASTER SWITCH: tắt/bật trả lời bot từ Admin. Khi OFF, bot vẫn nhận webhook và lưu DB nhưng không gửi tin ra Messenger.
    if (!isBotReplyEnabled()) {
        console.log("[BOT_REPLY_SWITCH] blocked text reply", senderId, String(text || '').slice(0, 120));
        logBlockedBotReply(senderId, text, "reply_switch_off", "text");
        return false;
    }

    // KHÓA CỨNG: khi sale/admin đã vào trả lời, mọi đường gửi tin của bot đều bị chặn tại cửa cuối.
    // Không để GPT/template/follow-up/timer chen ngang sale.
    if (!options.force && isBotHardPaused(senderId)) {
        console.log("AIGUKA SAFE_SEND blocked: human takeover active", senderId, new Date(Number(stateForGuard.humanTakeoverUntil)).toISOString());
        logBlockedBotReply(senderId, text, "human_takeover_active", "text", { humanTakeoverUntil: stateForGuard.humanTakeoverUntil });
        return false;
    }

    if (!options.force && isDuplicateBotOutbound(senderId, text)) {
        console.log("AIGUKA SAFE_SEND blocked: duplicate/rapid phone ask", senderId, String(text || '').slice(0, 120));
        logBlockedBotReply(senderId, text, "duplicate_or_rapid_phone_ask", "text");
        return false;
    }

    const url = `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            recipient: { id: senderId },
            message: { text }
        })
    });

    const result = await response.text();
    console.log("Facebook send status:", response.status);
    console.log("Facebook send result:", result);

    if (!response.ok) {
        throw new Error(`Facebook send failed: ${response.status} - ${result}`);
    }

    // Supabase logger: lưu tin bot sau khi Facebook xác nhận gửi thành công.
    const st = customerStates[senderId] || {};
    if (st) {
        st.lastBotReply = text;
        st.lastBotReplyTime = Date.now();
        if (containsPhoneAsk(text)) {
            st.askedPhone = true;
            st.lastPhoneAskTime = Date.now();
            st.phoneAskCount = Number(st.phoneAskCount || 0) + 1;
        }
        saveCustomerStates(customerStates);
    }
    logMessageToSupabase({
        senderId,
        pageId: st.lastPageId || "",
        role: "bot",
        text,
        messageType: "text",
        productGroup: toDbProductGroup(st.currentTopic || st.productType || st.lockedProduct || "") || "",
        intent: "bot_reply",
        source: "bot_api_send",
        raw: { source: "bot_api_send", facebook_status: response.status, facebook_result: result }
    }).catch(err => console.error("Supabase bot text log error:", err.message));
}


function inferCarouselProductCode(element = {}, logName = "") {
    const txt = normalizeIntentText([element.title, element.subtitle, logName].filter(Boolean).join(" "));
    if (["bep", "hut mui", "yamato", "kitchen", "chau rua bat", "voi bep"].some(w => txt.includes(w))) return "BEP";
    if (["quat", "fan", "canh"].some(w => txt.includes(w))) return "QUAT";
    if (["bon cau", "toilet", "bet", "thong minh", "wc"].some(w => txt.includes(w))) return "BC";
    if (["tu chau", "tu lavabo", "guong", "vanity"].some(w => txt.includes(w))) return "TC";
    if (["sen", "voi", "lavabo", "faucet"].some(w => txt.includes(w))) return "SEN";
    if (["combo", "phong tam", "thiet bi ve sinh", "bathroom"].some(w => txt.includes(w))) return "TBVS";
    return "SP";
}

function safeSku(code, idx) {
    return `${String(code || "SP").replace(/[^A-Z0-9]/gi, "").toUpperCase()}-${String(idx + 1).padStart(2, "0")}`;
}

function isPublicHttpUrl(url = "") {
    return /^https:\/\//i.test(String(url || ""));
}

function proxiedImageUrl(imageUrl = "") {
    const raw = String(imageUrl || "").trim();
    if (!isPublicHttpUrl(raw)) return raw;
    if (!AIGUKA_PUBLIC_URL || !AIGUKA_IMAGE_PROXY_ENABLED) return raw;
    // Facebook CDN links often render in Messenger but fail in Pancake/Meta Business Suite.
    // Proxy keeps a stable public URL and falls back gracefully if the source expires.
    if (/scontent\.|fbcdn\.|facebook\./i.test(raw)) {
        return `${AIGUKA_PUBLIC_URL}/image-proxy?u=${encodeURIComponent(raw)}`;
    }
    return raw;
}

function enhanceCarouselElementsForAdmin(elements = [], logName = "") {
    return (Array.isArray(elements) ? elements : []).slice(0, 10).map((element, idx) => {
        const code = inferCarouselProductCode(element, logName);
        const sku = element.sku || element.product_id || safeSku(code, idx);
        let title = String(element.title || element.name || "").trim();
        if (!title || /^example$/i.test(title)) title = "Mẫu sản phẩm";
        if (!title.includes(sku)) title = `${sku} | ${title}`;
        title = title.slice(0, 80);

        const oldSubtitle = String(element.subtitle || "").replace(/^example$/i, "").trim();
        const subtitle = (`Mã ${sku} | Hotline 0973693677` + (oldSubtitle ? ` | ${oldSubtitle}` : "")).slice(0, 80);
        const imageUrl = proxiedImageUrl(element.image_url || "");
        const buttons = Array.isArray(element.buttons) ? [...element.buttons] : [];
        if (!buttons.some(b => b && b.type === "postback" && String(b.payload || "").includes(sku)) && buttons.length < 3) {
            buttons.unshift({ type: "postback", title: `Chọn ${sku}`.slice(0, 20), payload: `SELECT_PRODUCT_${sku}` });
        }
        if (!buttons.some(b => b && b.type === "phone_number") && buttons.length < 3) {
            buttons.push({ type: "phone_number", title: "Gọi hotline", payload: "0973693677" });
        }

        // IMPORTANT: Facebook Generic Template only allows a strict set of keys.
        // Keep sku/product metadata in Supabase/raw logs, but never send them as element keys.
        const cleanButtons = buttons
            .filter(b => b && ["web_url", "postback", "phone_number"].includes(b.type))
            .slice(0, 3)
            .map(b => {
                if (b.type === "phone_number") return { type: "phone_number", title: String(b.title || "Gọi hotline").slice(0, 20), payload: String(b.payload || "0973693677") };
                if (b.type === "postback") return { type: "postback", title: String(b.title || "Chọn mẫu").slice(0, 20), payload: String(b.payload || `SELECT_PRODUCT_${sku}`).slice(0, 1000) };
                return { type: "web_url", title: String(b.title || "Xem chi tiết").slice(0, 20), url: String(b.url || imageUrl), webview_height_ratio: b.webview_height_ratio || "full", messenger_extensions: false };
            });

        const enhanced = {
            title,
            subtitle,
            image_url: imageUrl,
            buttons: cleanButtons
        };
        if (isPublicHttpUrl(imageUrl)) {
            enhanced.default_action = {
                type: "web_url",
                url: imageUrl,
                webview_height_ratio: "full",
                messenger_extensions: false
            };
        }
        return enhanced;
    }).filter(x => x.image_url && isPublicHttpUrl(x.image_url));
}

function sanitizeMessengerElements(elements = []) {
    const allowed = new Set(["title", "subtitle", "image_url", "default_action", "buttons"]);
    return (Array.isArray(elements) ? elements : []).map(el => {
        const clean = {};
        for (const key of Object.keys(el || {})) {
            if (allowed.has(key)) clean[key] = el[key];
        }
        if (Array.isArray(clean.buttons)) {
            clean.buttons = clean.buttons
                .filter(b => b && ["web_url", "postback", "phone_number"].includes(b.type))
                .slice(0, 3)
                .map(b => {
                    if (b.type === "phone_number") return { type: "phone_number", title: String(b.title || "Gọi hotline").slice(0, 20), payload: String(b.payload || "0973693677") };
                    if (b.type === "postback") return { type: "postback", title: String(b.title || "Chọn mẫu").slice(0, 20), payload: String(b.payload || "SELECT_PRODUCT").slice(0, 1000) };
                    return { type: "web_url", title: String(b.title || "Xem chi tiết").slice(0, 20), url: String(b.url || clean.image_url || AIGUKA_PUBLIC_URL || "https://www.facebook.com"), webview_height_ratio: b.webview_height_ratio || "full", messenger_extensions: false };
                });
        }
        return clean;
    });
}

async function sendTemplate(senderId, elements, logName) {
    // MASTER SWITCH: chặn mọi template/carousel khi tắt bot từ Admin.
    if (!isBotReplyEnabled()) {
        console.log("[BOT_REPLY_SWITCH] blocked template reply", senderId, logName || "template");
        logBlockedBotReply(senderId, `[template:${logName || "generic"}]`, "reply_switch_off", "template", { logName });
        return false;
    }

    // KHÓA CỨNG giống sendMessage: template/carousel cũng không được chen ngang sale.
    if (isBotHardPaused(senderId)) {
        const st = customerStates[String(senderId)] || {};
        console.log("AIGUKA SAFE_TEMPLATE blocked: human takeover active", senderId, st.humanTakeoverUntil ? new Date(Number(st.humanTakeoverUntil)).toISOString() : "");
        logBlockedBotReply(senderId, `[template:${logName || "generic"}]`, "human_takeover_active", "template", { logName, humanTakeoverUntil: st.humanTakeoverUntil });
        return false;
    }

    const enhancedElements = enhanceCarouselElementsForAdmin(elements, logName);
    const safeElements = sanitizeMessengerElements(enhancedElements);
    if (!safeElements.length) throw new Error(`${logName || 'Template'} has no valid public image elements`);
    const url = `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            recipient: { id: senderId },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "generic",
                        image_aspect_ratio: "square",
                        elements: safeElements
                    }
                }
            }
        })
    });

    const result = await response.text();
    console.log(`${logName} status:`, response.status);
    console.log(`${logName} result:`, result);

    if (!response.ok) {
        throw new Error(`${logName} failed: ${response.status} - ${result}`);
    }

    const st = customerStates[senderId] || {};
    logMessageToSupabase({
        senderId,
        pageId: st.lastPageId || "",
        role: "bot",
        text: `[template:${logName || "generic"}]`,
        messageType: "template",
        productGroup: toDbProductGroup(st.currentTopic || st.productType || st.lockedProduct || "") || "",
        intent: "bot_template",
        source: "bot_api_send",
        raw: { source: "bot_api_send", elements: safeElements, enhanced_elements: enhancedElements, original_elements: elements, facebook_status: response.status, facebook_result: result }
    }).catch(err => console.error("Supabase bot template log error:", err.message));
}

async function sendComboCarousel(senderId) {
    const elements = [
        {
            title: "Combo phổ thông 01",
            subtitle: "Phù hợp phòng tắm phổ thông, tiết kiệm chi phí",
            image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/721841502_3407023772807451_2219495493695105387_n.jpg?stp=dst-webp_fr_q75&_nc_cat=104&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeFmFpWydFScpHjZfZGIegsMnheWmvwORraeF5aa_A5Gtshvo5X27hDJxdHeib2fiKmaVuK0QZQfMqNZl0IwaXn2&_nc_ohc=1_7eDbD6dxgQ7kNvwEKcNjN&_nc_oc=AdqWd_2C8PLDr7llHjd9sGmu9MfMK4qRr9DjS4kS_mUXqSqO3nhkLgXMt6-CYgUr-qE&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af_yyrtvN6FYDEdWkds0WvrlBjF-MVk9K_EDfDjDCLH7MQ&oe=6A3F173F",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo phổ thông 02",
            subtitle: "Bộ phối sẵn, dễ lắp cho nhà mới",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/722363580_3407023566140805_6501584263051580923_n.jpg?stp=dst-webp_fr_q75&_nc_cat=111&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeFEEDG4i_WZ3FH8vERm_CT9M5ipV4CTLbYzmKlXgJMttnzTbZCsqhs984KgokKVm6LjzjW37p8bQBAmkuJgfaDV&_nc_ohc=P9N9qhDfw9gQ7kNvwGGjL3Z&_nc_oc=AdquXFo1OQfPJBT_9QY64KWMvMVHMGEqVAGZB0JcXSNo5YMHFPQ2A7s1YQD4by8rQwg&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af-GqPMTnXFrpe8kYFE60q09ZyiiqjW30sc2OAtm4MtXBA&oe=6A3F041C",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo phổ thông 03",
            subtitle: "Phù hợp căn hộ, nhà phố, phòng tắm nhỏ",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/722030414_3407023492807479_4272071537859353682_n.jpg?stp=dst-webp_fr_q75&_nc_cat=106&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEmWeC1VuHVVVPp2hWnGLOBH-h6fWPlTiUf6Hp9Y-VOJRKRGRjd3lbPUfl8IbbxcPJaHU6Z5ay2kWWkxKj68GWp&_nc_ohc=kG52JQwmI_gQ7kNvwG7w7Ly&_nc_oc=AdqaL5jaCh6XbOhVblfxC9NqVPdEZwZ0at5NMNCbf937lrKulDS2c128fEmk039k6vE&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=u-xhVRGH8O-Wqel_CNFKtw&_nc_ss=7b2a8&oh=00_Af-hIP9YYe_Dwst8bucrNct7NYI9c5rDKuQjiwvtvX2-Xg&oe=6A3F1D71",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo phổ thông 04",
            subtitle: "Mẫu tiết kiệm, đủ thiết bị cần dùng",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/723543437_3407023759474119_1152871356518316127_n.jpg?stp=dst-webp_fr_q75&_nc_cat=111&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHjHywu1goJoj4rcll7hF37F6gpfTctLaEXqCl9Ny0toRGp962s0cVTTIr0NxT6TtxgdcxzKY3qFS-de1IOZ3Pc&_nc_ohc=yzwCTaZRhFoQ7kNvwFNMXx0&_nc_oc=AdrhhhdBk_Z8t-wD3PfAlHk-sQO36rpf2BLfKg5HMbSXZOqBJRDIn0kR2_0suDtS2W4&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af9LJOhU0JTA5oIbQWPKKxh1X4HkMFU8tHIm586YJbZHlQ&oe=6A3EFAE4",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo phổ thông 05",
            subtitle: "Giá tốt, phù hợp công trình số lượng",
            image_url: "https://scontent.fhan5-6.fna.fbcdn.net/v/t45.1600-4/722097598_3407023746140787_3094052314991038689_n.jpg?stp=dst-webp_fr_q75&_nc_cat=107&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEx-5JrjhDSW5WKTJ1O3Twutqkpy-DlegK2qSnL4OV6AoFZyLk67lU7xkXXNbOkpQK4XSCoXhWvqwK1eFRwjraQ&_nc_ohc=wXzQyGT8RYUQ7kNvwF7im1p&_nc_oc=AdoQXbeF_59hTALN9pqt3PjDyLLUZQnPY_C2Upb-p8zQaT48TZ82CH6RRFlTS6MMDgE&_nc_zt=1&_nc_ht=scontent.fhan5-6.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af9IyJ9xVEqOPZ_cAhrl1ku_fen6k4TQuRawdK0U1aOTBQ&oe=6A3F06D5",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo đẹp 01",
            subtitle: "Mẫu đẹp hơn, phối đồng bộ",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/724414534_3407023669474128_6654698488176819038_n.jpg?stp=dst-webp_fr_q75&_nc_cat=101&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHACvlu0KvhLkjXOnnf6bOw9_sCnHDN9e_3-wKccM317-sN6_nRJrk0WbCMlpYG3AEXlLniBnW1DHIgvHDYTaA9&_nc_ohc=6WemwsdtinoQ7kNvwHVRB0a&_nc_oc=AdouwRUdoydBWrxsA-QQphXYGoL9DvO5Dmd282j-5hvGZfg931KjXi_KohvZa7l98xo&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=u-xhVRGH8O-Wqel_CNFKtw&_nc_ss=7b2a8&oh=00_Af_IKdEht3IyCtadRcq8idmCtJvhSh3JyPCFWa7WpOHD0A&oe=6A3F0FE9",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo đẹp 02",
            subtitle: "Phù hợp nhà mới, căn hộ, nhà phố",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/722074589_3407023709474124_2192680801667191676_n.jpg?stp=dst-webp_q70_s168x128&_nc_cat=106&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHnJ4k5B5lRET3XAU3IPYL2lLixa3kR35iUuLFreRHfmBxFcboZ3Cl35HcZb3SOT8N_gbiSz12TSecGCUu2IgPZ&_nc_ohc=X2qJ337q3QoQ7kNvwFZ426G&_nc_oc=AdrRVW6WYH-4TPLjnU5c1AcNrGo2_VNOmO5AWLSkZ8saz82SOj8ejLK34daenXCnTLY&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=78RevIFYinNeeYQnD38J7Q&_nc_ss=7b2a8&oh=00_Af-vCD6REiM1VxHEJx1qwJVUUQdJScbaY5NpudcKmoFzMQ&oe=6A3EFDE6",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo đẹp 03",
            subtitle: "Tối ưu chi phí nhưng vẫn đẹp",
            image_url: "https://scontent.fhan5-11.fna.fbcdn.net/v/t45.1600-4/724838572_3407023849474110_3761190961699111613_n.jpg?stp=dst-webp_fr_q75&_nc_cat=103&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEBRp7MplN8IqeHtPW6sC9PLTJcoG2ETS8tMlygbYRNL_r4u33rUMAjUqx3XVZCLnqzjBEfD9tWLxapY3b_fP0X&_nc_ohc=hmY84XaNO2EQ7kNvwGiYilH&_nc_oc=AdpOCfh0StWrmOjOF9COuqjsUU_q1LMuB33FUQxNm-vUh9EfAlyyk22rzTywbz3Fegc&_nc_zt=1&_nc_ht=scontent.fhan5-11.fna&_nc_gid=78RevIFYinNeeYQnD38J7Q&_nc_ss=7b2a8&oh=00_Af95Zz0PsNelB4Xo01bTvmacncpJ-2Mzbg4rDDWctzBAWw&oe=6A3EF4E1",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo cao cấp",
            subtitle: "Phù hợp nhà mới, biệt thự, khách sạn",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/728503197_3412240415619120_7947162624555401843_n.jpg?stp=dst-jpg_s168x128_tt6&_nc_cat=111&ccb=1-7&_nc_sid=d73f9c&_nc_eui2=AeF3mk0nPsH2Q9Tj_wooFLnspveGQ3uv0Iqm94ZDe6_QihRdvyEEDe7E6_f1A-xPZA1mLA6EZ-40_6TLeqDdD4NH&_nc_ohc=Yg1pDqiM0jwQ7kNvwGkgVuD&_nc_oc=Adprj7JBg-qAMY54CeYbt5CqkBc7jGGTz_0PEt2leWO0N-q-cyWk7PvA_rvArjTHTEQ&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=wVvG2jY_v91j5WXpHxrLyQ&_nc_ss=7b2a8&oh=00_Af-JfZhRivnIp5IXW8ZJT9eb5hXk0idM4mMk7r73vTnhPA&oe=6A3F2726",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo phòng tắm đẹp sang",
            subtitle: "Mẫu sang, hợp không gian cao cấp",
            image_url: "https://scontent.fhan5-6.fna.fbcdn.net/v/t45.1600-4/727773203_3412243075618854_6908507580940590551_n.jpg?_nc_cat=107&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeGNE58Pfb6GQc_RlYtpaPeZ60UwuoiNCF_rRTC6iI0IX9oSnpvptkEsuZW7_HcVqTuLHcOLtxtxOgsbpd5Nvpc1&_nc_ohc=gt2o__Mz01oQ7kNvwF8-DMy&_nc_oc=AdrQENrFDuaBaSi6cmlaJXR-eykfpsIQg8_GuW9rngjN8X97xhhc_2tB3xYdf1pvzqk&_nc_zt=1&_nc_ht=scontent.fhan5-6.fna&_nc_gid=78Wwh70qamiZp3hx9mS8Xg&_nc_ss=7b2a8&oh=00_Af8D_7uLN6NnHETuS2Te_Fz_a4X5bTQuS3sqStr3IBPopA&oe=6A3EF9EC",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        }
    ];

    await sendTemplate(senderId, elements, "Combo carousel");
}

async function sendFanCarousel(senderId) {
    const elements = [
        {
            title: "Quạt 10 cánh cao cấp",
            subtitle: "Sải lớn, hợp phòng khách rộng, không gian sang trọng",
            image_url: "https://scontent.fhan5-9.fna.fbcdn.net/v/t45.1600-4/728597413_3412225568953938_5048258706912707012_n.jpg?_nc_cat=110&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeF9_KEAt19bMbLGn9ImPdBErXek8XEmc1Std6TxcSZzVJcqNZD2S29UtKFH2hKEKAanUmzGmvpFHDAbbuFUebxx&_nc_ohc=9hQEkg60bncQ7kNvwFMP4Qb&_nc_oc=AdoO5dx259kvQ_3xJWioFcjyyCEHM9XD2jwHQ5Jn2d78H8ZBjY6JwcRy6QbFFIm6P8E&_nc_zt=1&_nc_ht=scontent.fhan5-9.fna&_nc_gid=H81qwU0PpFnPWUSKJeZqCw&_nc_ss=7b2a8&oh=00_Af8j0NRqieKJFAi1UyLA5JHDTbH_cX8-3a8q1Oi9S-uAiw&oe=6A3F1338",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Quạt 10-8 cánh mẫu 2",
            subtitle: "Mẫu trang trí cao cấp, hợp phòng khách lớn",
            image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/728618331_3412225595620602_3289339737406152436_n.png?stp=dst-jpg_tt6&_nc_cat=102&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeFD7mMN7hdaPIBQRcOohMdLoNSH175SZbug1IfXvlJlu0TcfGdylmrTyaVWAlebn5lHCAp5ciKNuqaTybcsSeMz&_nc_ohc=a8qSkZXNdqAQ7kNvwF3qIGb&_nc_oc=Ado36HTGSvmBt3zfu0au8OoN79CtIHo0NYkxNr0p8pDLfxP65QY-FEGXXQDy-cs5gIo&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=AhyAU3j8PpSeWDT8Z0Gu_Q&_nc_ss=7b2a8&oh=00_Af_IRHEjLdKzq57l6YVQHLBb5q2zsY_CHAOLoMIvYEr_Jw&oe=6A3EF058",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Quạt trần 5 cánh 55W",
            subtitle: "Phù hợp phòng vừa, mẫu hiện đại, dễ phối nội thất",
            image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/727719223_3412214488955046_3127207876950040699_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeGIbhNqPizCG827jRKi2ujsHQ5r-eC51B0dDmv54LnUHXQPXRcQPF7TG8HJicZfMBYw702DbO6KpFWzJH9aJm5T&_nc_ohc=V-ExMLpYn9EQ7kNvwGsOcGj&_nc_oc=Adr5zBbqRVUNFvx2QhS0oYraja93d0EFWSWxPusfqiE-r3ppgR8l4wSWdCKpgCnaf24&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=bcw2J8GkfUEXJriVz1oLOQ&_nc_ss=7b2a8&oh=00_Af_YhRRmZgntjGTgS36kmpcsqaU1W_kyjRzgDCs2mVLdwA&oe=6A3F095A",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Quạt trần 5 cánh 90W",
            subtitle: "Gió mạnh hơn, phù hợp phòng lớn hoặc cần thoáng mát",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/729088829_3412214475621714_8370697354332284349_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeEXTBgj2blEZtj5XpRbwq_fJE2SQubOxP8kTZJC5s7E_4rIdsmmzF-6HyCiTRpgvp306okGBoT89V91lrhOh31h&_nc_ohc=Sv01MBSqGuYQ7kNvwERCf_a&_nc_oc=AdoCjduM22tUgLaO3keafuLJsnERx0hZWZPntd6VrkH0quDRDZgzHL2iS7NIZSvT9uc&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=aJDU5max7NArlA__yCpytQ&_nc_ss=7b2a8&oh=00_Af_l1bxVslTjPhOMBSODpzbWSJOz90pDwRY5KayP9dc3Mw&oe=6A3F1053",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Quạt trần 5 cánh 55W mẫu 2",
            subtitle: "Mẫu 5 cánh hiện đại, hợp phòng khách và phòng ngủ",
            image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/728484704_3412214465621715_4515721995423721398_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeEEj93fuQ2XXzuTkZgexJy4VtD499l8ne9W0Pj32Xyd70CQVLy6NlPsWXGbpa2AFaL8U4Vkdj4t40N8JUfsic0Q&_nc_ohc=3SsxlVylk3wQ7kNvwEGp41T&_nc_oc=Adpp_DIO1u8FRgeXcsOl2KOkhrlr-ADqYkRDhJy2DSPvFabIdlfkd4kN8Ni1wE-kq2Q&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=ca8F9vQEMyatadD9-_vafA&_nc_ss=7b2a8&oh=00_Af-5nbP7M3y07WCKC41bu9HECRen-ErUH6V2LDCwBeZcEQ&oe=6A3EF165",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Quạt 8 cánh vàng gương",
            subtitle: "Mẫu sang, hợp phòng khách, biệt thự, nhà hàng",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/728760035_3412214442288384_2821812757948103391_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeE1gLmEnYhcYcAdRm8Y4Efkto6qjVItQGq2jqqNUi1AapSW-7fcjspTeNE7RfslV2U2aqUW60_vaRtgX98O0UA4&_nc_ohc=tYU3byEPwI4Q7kNvwFf8Y9R&_nc_oc=AdqDOn6-rpBe36YXADWcDu7GdCx10JwawIw2QXny5P8lsKet-WABjseVL42k6xqPB4k&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=Sq569PbIRY0sEDsucJnQeA&_nc_ss=7b2a8&oh=00_Af-gu2ESXEnmmi83L6x99RSXRZ2vAwc_iVahh3CxEpzuSw&oe=6A3EF448",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Quạt 8 cánh màu gỗ",
            subtitle: "Tông nâu gỗ, hợp nội thất ấm và sang",
            image_url: "https://scontent.fhan5-6.fna.fbcdn.net/v/t45.1600-4/728532874_3412214428955052_5606934162449542415_n.jpg?_nc_cat=105&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeFDdkyqaqMM5-Od42GYHs1oha648laqL8GFrrjyVqovwZ2K2yEM2sVGjDIE9ihvZoJTeuwlmp9cPpJdEp5Ev1_r&_nc_ohc=heosDSt4O5YQ7kNvwHxIwm6&_nc_oc=Adq3bKbZRsGQjOa-04Xbl4O6r_o6yph7GM4g3s95kZ29XVNJZQyek2W_6n8hTfplruk&_nc_zt=1&_nc_ht=scontent.fhan5-6.fna&_nc_gid=XVJP-C1yMwqqDktU5JceRQ&_nc_ss=7b2a8&oh=00_Af-L4TE1d8ByLAiXF2HLYsFEbSYpkjVPxWHNu7MNadBoTg&oe=6A3F13B0",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        }
        
    ];

    await sendTemplate(senderId, elements, "Fan carousel");
}

async function sendFaucetCarousel(senderId) {
    const elements = [
        {
            title: "Sen tắm, vòi, chậu rửa 01",
            subtitle: "Mẫu thiết bị vệ sinh đẹp, phù hợp nhà tắm hiện đại",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t39.30808-6/703191027_969113915979098_8030725390918618210_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeFa7VMnu1zyij_pDvCcZvU6CxM-YlbmHdwLEz5iVuYd3Ph9NGGH5Lt0ikG62Y373ByO0bTV7AvLIVbz5YfYWkPz&_nc_ohc=FXIstFkz2jgQ7kNvwGR7x46&_nc_oc=Adp2CFxuAzGCYDM_R3v28Nvu4YLJ6NGsOtsQCxTJB2ksW8HX5Fgh5IC0SBWYWuk_Xuc&_nc_zt=23&_nc_ht=scontent.fhan5-10.fna&_nc_gid=lw2ZNwyTAGhLXWF-rtdkWA&_nc_ss=7b2a8&oh=00_Af_EgBdj7r_WvXERm2fgzd05vy75frJVDtiEqjKEltcRug&oe=6A3F3267",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 02",
            subtitle: "Phù hợp combo nhà tắm, lavabo, sen vòi đồng bộ",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t39.30808-6/703434110_969113955979094_6569529519103445901_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeHH32-t5cp1HOEwtLnl4efgQhU--7nx89lCFT77ufHz2QV1yYoahgSVjwQI2-zeUAnF19mFaOZxkGYq-bgw-2hd&_nc_ohc=j9lhKFp23ucQ7kNvwHvYQhG&_nc_oc=AdpuHFpaeWpEMrFjRKfm3UV9cWafoW778nyCdhmjr4fL6UaY6WC9_OOHLGGyvgZDyYs&_nc_zt=23&_nc_ht=scontent.fhan5-8.fna&_nc_gid=2nlcgGcyzzW8UV4MhdfXGQ&_nc_ss=7b2a8&oh=00_Af8RbP_8DlRACiv4mKMStD_AoNEj9jbywVqODZk3agHO4A&oe=6A3F4C11",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 03",
            subtitle: "Mẫu dễ phối cho phòng tắm mới hoặc cải tạo",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t39.30808-6/706144052_969111872645969_6005742897087813212_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeGj-42sFoINEVRGYCMM1R_UKp_Y-w156xIqn9j7DXnrEmKdcMcFHXS3zI-Y2TMt6tPxyur0gAGB4wBddvWthwcn&_nc_ohc=E9kNIqp-bZQQ7kNvwEw5yxd&_nc_oc=AdqkXpglB2t7rhpnWZVBceSRhmbOumuWVt9Oo7iVGB8p3dF8Gnyy-hXCjSv3HxrNRAo&_nc_zt=23&_nc_ht=scontent.fhan5-8.fna&_nc_gid=lw2ZNwyTAGhLXWF-rtdkWA&_nc_ss=7b2a8&oh=00_Af-lY4oCbYzy5GDorhoCMILonvaSzNy-aa7bQt7-RGSX0Q&oe=6A3F4915",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 04",
            subtitle: "Thiết bị vệ sinh đẹp, dùng cho phòng tắm gia đình",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t39.30808-6/703762770_969115259312297_1234080936578252503_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeHE_8YJMCLPCcQYgjumiKeTgWMGOUdcXKqBYwY5R1xcquANKOQ9Uf9pMxiS4QBdADat6q0Q8SCuY6WSXdTEmm_E&_nc_ohc=ODXv-MU4eSUQ7kNvwG7uIeC&_nc_oc=AdrNUwwyDwfX_v5xCCIYW--5d5QfNzzRQB2o4hR1ZlQbS6R5srP_78Ej1zHwmfq3UVs&_nc_zt=23&_nc_ht=scontent.fhan5-10.fna&_nc_gid=2nlcgGcyzzW8UV4MhdfXGQ&_nc_ss=7b2a8&oh=00_Af_gojJu4NmULdT9o_hrC4s_jKuapV2mcdWKdqyKhgG4gA&oe=6A3F4185",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 05",
            subtitle: "Nhiều mẫu sen vòi, chậu rửa, phụ kiện nhà tắm",
            image_url: "https://scontent.fhan5-11.fna.fbcdn.net/v/t39.30808-6/703702032_969117399312083_6892088813610533309_n.jpg?_nc_cat=103&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeEvTWzHrIEhrIerdEc_k2iDSE2UrPzOhPFITZSs_M6E8Sk6makKCWFrEoHCr7oDfEXJvDVne13v71uXRSrzRPzj&_nc_ohc=mHj5B7Z9BL4Q7kNvwFelrTN&_nc_oc=Ados1qvWrG3HRD1sbVz3-A2XILgJkP5dmiIEJepme3MVglSvpEBAygL6eufk1lPoKws&_nc_zt=23&_nc_ht=scontent.fhan5-11.fna&_nc_gid=x8iKRicU2knMbmoxx1AlrQ&_nc_ss=7b2a8&oh=00_Af_hmtEdk1jG6IwfcGnWip7TsMXILlPdw0_EgIN5N6J3Tg&oe=6A3F202F",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 06",
            subtitle: "Phù hợp chọn lẻ hoặc phối thành combo phòng tắm",
            image_url: "https://scontent.fhan5-11.fna.fbcdn.net/v/t39.30808-6/703394730_969102089313614_7563853999344157562_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeGvzNma-qzwKRgUIPHbS059IIw15_LYPAUgjDXn8tg8BV2Ut5nwfaeG5lp_YcacQ3Cr3QwwqDKWLc2LX4K74PzG&_nc_ohc=nmQI8xCRMDEQ7kNvwFXJeCi&_nc_oc=AdoYM8KTvfsgjVWIvqQssnfYBm1hlQrHLsK7fXayjDETX17KsiemOzMWBvsvc149PhA&_nc_zt=23&_nc_ht=scontent.fhan5-11.fna&_nc_gid=bhKe68cscEfcIRc6L2-GAw&_nc_ss=7b2a8&oh=00_Af_76vjM5pypwxqSK04aZBdo6_WdM4oOIcw5lqo7zOlg4A&oe=6A3F3660",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 07",
            subtitle: "Dòng sen vòi, chậu rửa đẹp cho phòng tắm hiện đại",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t39.30808-6/697199723_962937126596777_8498925046413907390_n.jpg?_nc_cat=106&ccb=1-7&_nc_sid=f727a1&_nc_eui2=AeGlX_8xtvPrub2HpN7Hzfku3fOs0Y5yUxDd86zRjnJTELZEtl4LzdKXfdSiqOoRhJ6tWcQ5P4A1etQYs76IPG63&_nc_ohc=v8W4ap3J-R8Q7kNvwE-cwga&_nc_oc=AdonMkXkkUYTM8qvwpDFjqEoJpil0dP62pjuOl75hbfslugIhe8k_pH0c4AgHcqtRQM&_nc_zt=23&_nc_ht=scontent.fhan5-8.fna&_nc_gid=94SF_MxkkrVw54j0iFlASQ&_nc_ss=7b2a8&oh=00_Af-8-ZdfJDnjjDo9_6HmC06n7lXN8lhknfBGK5jpoDPLEw&oe=6A3F2B00",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 08",
            subtitle: "Mẫu phù hợp khách muốn chọn thiết bị đồng bộ",
            image_url: "https://scontent.fhan5-11.fna.fbcdn.net/v/t39.30808-6/698445527_962937943263362_5571045644058564871_n.jpg?_nc_cat=103&ccb=1-7&_nc_sid=f727a1&_nc_eui2=AeFgcEY2yasUofU8BdNvLvpalsJuq_DOb4-Wwm6r8M5vj6smUIYHJoT_QSDAurTLkIRIGdMSZVqZj4w_xjbGV5Qg&_nc_ohc=bQ4bkAprWWcQ7kNvwFLqrJk&_nc_oc=AdqteoGgcC4ZC2eWLRsKE3P01FfgwUE2_YLSBtCc8JrwsK-w7BzBXHsswoeDZ_KhSH4&_nc_zt=23&_nc_ht=scontent.fhan5-11.fna&_nc_gid=5yF49pHm5e0YEaFaAKWDgg&_nc_ss=7b2a8&oh=00_Af8juSDpxk4_p1GkD8RDzR2dh1dSTfiyd78qC_1bH7O_YQ&oe=6A3F2C29",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Sen tắm, vòi, chậu rửa 09",
            subtitle: "Có thể phối cùng lavabo, bồn cầu, tủ chậu",
            image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t39.30808-6/698948687_962937056596784_1757048518063761369_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=f727a1&_nc_eui2=AeGL5Q10OoGXwxb9VEsfUkDBJg4_NdA8AuImDj810DwC4qnm3OY1AxUv9vaIlWs1oFtSmNKdu2hT2-aSCKW3fv7l&_nc_ohc=FasGTiiRATQQ7kNvwG3EAM5&_nc_oc=Adp5QKem01g3WYOWmHru10TtFFt_wU5NfoBlY5iI27WU6WTIM9tc7TGJ-dmHMApl_u8&_nc_zt=23&_nc_ht=scontent.fhan5-2.fna&_nc_gid=94SF_MxkkrVw54j0iFlASQ&_nc_ss=7b2a8&oh=00_Af8nmGSdK6ZHQVMBUnrklY2vyPlHe2-cVDE9wL3eLofmCg&oe=6A3F42D5",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        }
    ];

    await sendTemplate(senderId, elements, "Faucet carousel");
}

function shouldAutoSendCarouselAfterReply(text) {
    const t = String(text || "").toLowerCase();

    // Chỉ tự gửi carousel khi AI thật sự hứa gửi mẫu/ảnh bên dưới.
    // Không dùng "anh" vì đó là đại từ xưng hô, không phải ảnh.
    const hasSampleWord =
        t.includes("mẫu") ||
        t.includes("mau") ||
        t.includes("ảnh") ||
        t.includes("hình") ||
        t.includes("hinh");

    const hasSendPromise =
        t.includes("gửi") ||
        t.includes("gui") ||
        t.includes("bên dưới") ||
        t.includes("ben duoi") ||
        t.includes("dưới đây") ||
        t.includes("duoi day");

    return hasSampleWord && hasSendPromise;
}

function hasRecentCarousel(state) {
    if (!state || !state.lastCarouselTime) return false;
    return Date.now() - Number(state.lastCarouselTime) < Number(currentWorkingSettings().carousel_cooldown_minutes || 5) * 60 * 1000;
}

function buildAfterSamplePhoneAsk(productType) {
    if (productType === "kitchen_bath") {
        return "Bên em còn nhiều mẫu phối đồng bộ bếp và phòng tắm hơn nữa. Anh cho em xin số Zalo hoặc số điện thoại, em gửi album đầy đủ và báo giá chi tiết từng bộ ạ.";
    }

    if (productType === "combo") {
        return "Combo phòng tắm bên em có nhiều phân khúc từ cơ bản đến cao cấp, giá phụ thuộc số món, thương hiệu và mẫu chọn. Anh cho em xin số Zalo hoặc số điện thoại, em gửi album đầy đủ và báo giá chi tiết từng bộ ạ.";
    }

    if (productType === "fan") {
        return "Anh thích mẫu nào hoặc cần theo diện tích phòng bao nhiêu m2 ạ? Anh cho em xin số Zalo hoặc số điện thoại, em gửi thêm mẫu thực tế và báo giá chi tiết ạ.";
    }

    return "Anh xem mẫu nào phù hợp thì nhắn em nhé. Anh cho em xin số Zalo hoặc số điện thoại, em gửi album đầy đủ và báo giá chi tiết từng mẫu ạ.";
}


const PRODUCT_IMAGE_GALLERIES = {
    combo: [
    {
        "title": "Combo phổ thông 01",
        "subtitle": "Phù hợp phòng tắm phổ thông, tiết kiệm chi phí",
        "image_url": "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/721841502_3407023772807451_2219495493695105387_n.jpg?stp=dst-webp_fr_q75&_nc_cat=104&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeFmFpWydFScpHjZfZGIegsMnheWmvwORraeF5aa_A5Gtshvo5X27hDJxdHeib2fiKmaVuK0QZQfMqNZl0IwaXn2&_nc_ohc=1_7eDbD6dxgQ7kNvwEKcNjN&_nc_oc=AdqWd_2C8PLDr7llHjd9sGmu9MfMK4qRr9DjS4kS_mUXqSqO3nhkLgXMt6-CYgUr-qE&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af_yyrtvN6FYDEdWkds0WvrlBjF-MVk9K_EDfDjDCLH7MQ&oe=6A3F173F"
    },
    {
        "title": "Combo phổ thông 02",
        "subtitle": "Bộ phối sẵn, dễ lắp cho nhà mới",
        "image_url": "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/722363580_3407023566140805_6501584263051580923_n.jpg?stp=dst-webp_fr_q75&_nc_cat=111&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeFEEDG4i_WZ3FH8vERm_CT9M5ipV4CTLbYzmKlXgJMttnzTbZCsqhs984KgokKVm6LjzjW37p8bQBAmkuJgfaDV&_nc_ohc=P9N9qhDfw9gQ7kNvwGGjL3Z&_nc_oc=AdquXFo1OQfPJBT_9QY64KWMvMVHMGEqVAGZB0JcXSNo5YMHFPQ2A7s1YQD4by8rQwg&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af-GqPMTnXFrpe8kYFE60q09ZyiiqjW30sc2OAtm4MtXBA&oe=6A3F041C"
    },
    {
        "title": "Combo phổ thông 03",
        "subtitle": "Phù hợp căn hộ, nhà phố, phòng tắm nhỏ",
        "image_url": "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/722030414_3407023492807479_4272071537859353682_n.jpg?stp=dst-webp_fr_q75&_nc_cat=106&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEmWeC1VuHVVVPp2hWnGLOBH-h6fWPlTiUf6Hp9Y-VOJRKRGRjd3lbPUfl8IbbxcPJaHU6Z5ay2kWWkxKj68GWp&_nc_ohc=kG52JQwmI_gQ7kNvwG7w7Ly&_nc_oc=AdqaL5jaCh6XbOhVblfxC9NqVPdEZwZ0at5NMNCbf937lrKulDS2c128fEmk039k6vE&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=u-xhVRGH8O-Wqel_CNFKtw&_nc_ss=7b2a8&oh=00_Af-hIP9YYe_Dwst8bucrNct7NYI9c5rDKuQjiwvtvX2-Xg&oe=6A3F1D71"
    },
    {
        "title": "Combo phổ thông 04",
        "subtitle": "Mẫu tiết kiệm, đủ thiết bị cần dùng",
        "image_url": "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/723543437_3407023759474119_1152871356518316127_n.jpg?stp=dst-webp_fr_q75&_nc_cat=111&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHjHywu1goJoj4rcll7hF37F6gpfTctLaEXqCl9Ny0toRGp962s0cVTTIr0NxT6TtxgdcxzKY3qFS-de1IOZ3Pc&_nc_ohc=yzwCTaZRhFoQ7kNvwFNMXx0&_nc_oc=AdrhhhdBk_Z8t-wD3PfAlHk-sQO36rpf2BLfKg5HMbSXZOqBJRDIn0kR2_0suDtS2W4&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af9LJOhU0JTA5oIbQWPKKxh1X4HkMFU8tHIm586YJbZHlQ&oe=6A3EFAE4"
    },
    {
        "title": "Combo phổ thông 05",
        "subtitle": "Giá tốt, phù hợp công trình số lượng",
        "image_url": "https://scontent.fhan5-6.fna.fbcdn.net/v/t45.1600-4/722097598_3407023746140787_3094052314991038689_n.jpg?stp=dst-webp_fr_q75&_nc_cat=107&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEx-5JrjhDSW5WKTJ1O3Twutqkpy-DlegK2qSnL4OV6AoFZyLk67lU7xkXXNbOkpQK4XSCoXhWvqwK1eFRwjraQ&_nc_ohc=wXzQyGT8RYUQ7kNvwF7im1p&_nc_oc=AdoQXbeF_59hTALN9pqt3PjDyLLUZQnPY_C2Upb-p8zQaT48TZ82CH6RRFlTS6MMDgE&_nc_zt=1&_nc_ht=scontent.fhan5-6.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af9IyJ9xVEqOPZ_cAhrl1ku_fen6k4TQuRawdK0U1aOTBQ&oe=6A3F06D5"
    },
    {
        "title": "Combo đẹp 01",
        "subtitle": "Mẫu đẹp hơn, phối đồng bộ",
        "image_url": "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/724414534_3407023669474128_6654698488176819038_n.jpg?stp=dst-webp_fr_q75&_nc_cat=101&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHACvlu0KvhLkjXOnnf6bOw9_sCnHDN9e_3-wKccM317-sN6_nRJrk0WbCMlpYG3AEXlLniBnW1DHIgvHDYTaA9&_nc_ohc=6WemwsdtinoQ7kNvwHVRB0a&_nc_oc=AdouwRUdoydBWrxsA-QQphXYGoL9DvO5Dmd282j-5hvGZfg931KjXi_KohvZa7l98xo&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=u-xhVRGH8O-Wqel_CNFKtw&_nc_ss=7b2a8&oh=00_Af_IKdEht3IyCtadRcq8idmCtJvhSh3JyPCFWa7WpOHD0A&oe=6A3F0FE9"
    },
    {
        "title": "Combo đẹp 02",
        "subtitle": "Phù hợp nhà mới, căn hộ, nhà phố",
        "image_url": "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/722074589_3407023709474124_2192680801667191676_n.jpg?stp=dst-webp_q70_s168x128&_nc_cat=106&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHnJ4k5B5lRET3XAU3IPYL2lLixa3kR35iUuLFreRHfmBxFcboZ3Cl35HcZb3SOT8N_gbiSz12TSecGCUu2IgPZ&_nc_ohc=X2qJ337q3QoQ7kNvwFZ426G&_nc_oc=AdrRVW6WYH-4TPLjnU5c1AcNrGo2_VNOmO5AWLSkZ8saz82SOj8ejLK34daenXCnTLY&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=78RevIFYinNeeYQnD38J7Q&_nc_ss=7b2a8&oh=00_Af-vCD6REiM1VxHEJx1qwJVUUQdJScbaY5NpudcKmoFzMQ&oe=6A3EFDE6"
    },
    {
        "title": "Combo đẹp 03",
        "subtitle": "Tối ưu chi phí nhưng vẫn đẹp",
        "image_url": "https://scontent.fhan5-11.fna.fbcdn.net/v/t45.1600-4/724838572_3407023849474110_3761190961699111613_n.jpg?stp=dst-webp_fr_q75&_nc_cat=103&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEBRp7MplN8IqeHtPW6sC9PLTJcoG2ETS8tMlygbYRNL_r4u33rUMAjUqx3XVZCLnqzjBEfD9tWLxapY3b_fP0X&_nc_ohc=hmY84XaNO2EQ7kNvwGiYilH&_nc_oc=AdpOCfh0StWrmOjOF9COuqjsUU_q1LMuB33FUQxNm-vUh9EfAlyyk22rzTywbz3Fegc&_nc_zt=1&_nc_ht=scontent.fhan5-11.fna&_nc_gid=78RevIFYinNeeYQnD38J7Q&_nc_ss=7b2a8&oh=00_Af95Zz0PsNelB4Xo01bTvmacncpJ-2Mzbg4rDDWctzBAWw&oe=6A3EF4E1"
    },
    {
        "title": "Combo cao cấp",
        "subtitle": "Phù hợp nhà mới, biệt thự, khách sạn",
        "image_url": "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/728503197_3412240415619120_7947162624555401843_n.jpg?stp=dst-jpg_s168x128_tt6&_nc_cat=111&ccb=1-7&_nc_sid=d73f9c&_nc_eui2=AeF3mk0nPsH2Q9Tj_wooFLnspveGQ3uv0Iqm94ZDe6_QihRdvyEEDe7E6_f1A-xPZA1mLA6EZ-40_6TLeqDdD4NH&_nc_ohc=Yg1pDqiM0jwQ7kNvwGkgVuD&_nc_oc=Adprj7JBg-qAMY54CeYbt5CqkBc7jGGTz_0PEt2leWO0N-q-cyWk7PvA_rvArjTHTEQ&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=wVvG2jY_v91j5WXpHxrLyQ&_nc_ss=7b2a8&oh=00_Af-JfZhRivnIp5IXW8ZJT9eb5hXk0idM4mMk7r73vTnhPA&oe=6A3F2726"
    },
    {
        "title": "Combo phòng tắm đẹp sang",
        "subtitle": "Mẫu sang, hợp không gian cao cấp",
        "image_url": "https://scontent.fhan5-6.fna.fbcdn.net/v/t45.1600-4/727773203_3412243075618854_6908507580940590551_n.jpg?_nc_cat=107&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeGNE58Pfb6GQc_RlYtpaPeZ60UwuoiNCF_rRTC6iI0IX9oSnpvptkEsuZW7_HcVqTuLHcOLtxtxOgsbpd5Nvpc1&_nc_ohc=gt2o__Mz01oQ7kNvwF8-DMy&_nc_oc=AdrQENrFDuaBaSi6cmlaJXR-eykfpsIQg8_GuW9rngjN8X97xhhc_2tB3xYdf1pvzqk&_nc_zt=1&_nc_ht=scontent.fhan5-6.fna&_nc_gid=78Wwh70qamiZp3hx9mS8Xg&_nc_ss=7b2a8&oh=00_Af8D_7uLN6NnHETuS2Te_Fz_a4X5bTQuS3sqStr3IBPopA&oe=6A3EF9EC"
    }
],
    fan: [
    {
        "title": "Quạt 10 cánh cao cấp",
        "subtitle": "Sải lớn, hợp phòng khách rộng, không gian sang trọng",
        "image_url": "https://scontent.fhan5-9.fna.fbcdn.net/v/t45.1600-4/728597413_3412225568953938_5048258706912707012_n.jpg?_nc_cat=110&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeF9_KEAt19bMbLGn9ImPdBErXek8XEmc1Std6TxcSZzVJcqNZD2S29UtKFH2hKEKAanUmzGmvpFHDAbbuFUebxx&_nc_ohc=9hQEkg60bncQ7kNvwFMP4Qb&_nc_oc=AdoO5dx259kvQ_3xJWioFcjyyCEHM9XD2jwHQ5Jn2d78H8ZBjY6JwcRy6QbFFIm6P8E&_nc_zt=1&_nc_ht=scontent.fhan5-9.fna&_nc_gid=H81qwU0PpFnPWUSKJeZqCw&_nc_ss=7b2a8&oh=00_Af8j0NRqieKJFAi1UyLA5JHDTbH_cX8-3a8q1Oi9S-uAiw&oe=6A3F1338"
    },
    {
        "title": "Quạt 10-8 cánh mẫu 2",
        "subtitle": "Mẫu trang trí cao cấp, hợp phòng khách lớn",
        "image_url": "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/728618331_3412225595620602_3289339737406152436_n.png?stp=dst-jpg_tt6&_nc_cat=102&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeFD7mMN7hdaPIBQRcOohMdLoNSH175SZbug1IfXvlJlu0TcfGdylmrTyaVWAlebn5lHCAp5ciKNuqaTybcsSeMz&_nc_ohc=a8qSkZXNdqAQ7kNvwF3qIGb&_nc_oc=Ado36HTGSvmBt3zfu0au8OoN79CtIHo0NYkxNr0p8pDLfxP65QY-FEGXXQDy-cs5gIo&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=AhyAU3j8PpSeWDT8Z0Gu_Q&_nc_ss=7b2a8&oh=00_Af_IRHEjLdKzq57l6YVQHLBb5q2zsY_CHAOLoMIvYEr_Jw&oe=6A3EF058"
    },
    {
        "title": "Quạt trần 5 cánh 55W",
        "subtitle": "Phù hợp phòng vừa, mẫu hiện đại, dễ phối nội thất",
        "image_url": "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/727719223_3412214488955046_3127207876950040699_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeGIbhNqPizCG827jRKi2ujsHQ5r-eC51B0dDmv54LnUHXQPXRcQPF7TG8HJicZfMBYw702DbO6KpFWzJH9aJm5T&_nc_ohc=V-ExMLpYn9EQ7kNvwGsOcGj&_nc_oc=Adr5zBbqRVUNFvx2QhS0oYraja93d0EFWSWxPusfqiE-r3ppgR8l4wSWdCKpgCnaf24&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=bcw2J8GkfUEXJriVz1oLOQ&_nc_ss=7b2a8&oh=00_Af_YhRRmZgntjGTgS36kmpcsqaU1W_kyjRzgDCs2mVLdwA&oe=6A3F095A"
    },
    {
        "title": "Quạt trần 5 cánh 90W",
        "subtitle": "Gió mạnh hơn, phù hợp phòng lớn hoặc cần thoáng mát",
        "image_url": "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/729088829_3412214475621714_8370697354332284349_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeEXTBgj2blEZtj5XpRbwq_fJE2SQubOxP8kTZJC5s7E_4rIdsmmzF-6HyCiTRpgvp306okGBoT89V91lrhOh31h&_nc_ohc=Sv01MBSqGuYQ7kNvwERCf_a&_nc_oc=AdoCjduM22tUgLaO3keafuLJsnERx0hZWZPntd6VrkH0quDRDZgzHL2iS7NIZSvT9uc&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=aJDU5max7NArlA__yCpytQ&_nc_ss=7b2a8&oh=00_Af_l1bxVslTjPhOMBSODpzbWSJOz90pDwRY5KayP9dc3Mw&oe=6A3F1053"
    },
    {
        "title": "Quạt trần 5 cánh 55W mẫu 2",
        "subtitle": "Mẫu 5 cánh hiện đại, hợp phòng khách và phòng ngủ",
        "image_url": "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/728484704_3412214465621715_4515721995423721398_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeEEj93fuQ2XXzuTkZgexJy4VtD499l8ne9W0Pj32Xyd70CQVLy6NlPsWXGbpa2AFaL8U4Vkdj4t40N8JUfsic0Q&_nc_ohc=3SsxlVylk3wQ7kNvwEGp41T&_nc_oc=Adpp_DIO1u8FRgeXcsOl2KOkhrlr-ADqYkRDhJy2DSPvFabIdlfkd4kN8Ni1wE-kq2Q&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=ca8F9vQEMyatadD9-_vafA&_nc_ss=7b2a8&oh=00_Af-5nbP7M3y07WCKC41bu9HECRen-ErUH6V2LDCwBeZcEQ&oe=6A3EF165"
    },
    {
        "title": "Quạt 8 cánh vàng gương",
        "subtitle": "Mẫu sang, hợp phòng khách, biệt thự, nhà hàng",
        "image_url": "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/728760035_3412214442288384_2821812757948103391_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeE1gLmEnYhcYcAdRm8Y4Efkto6qjVItQGq2jqqNUi1AapSW-7fcjspTeNE7RfslV2U2aqUW60_vaRtgX98O0UA4&_nc_ohc=tYU3byEPwI4Q7kNvwFf8Y9R&_nc_oc=AdqDOn6-rpBe36YXADWcDu7GdCx10JwawIw2QXny5P8lsKet-WABjseVL42k6xqPB4k&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=Sq569PbIRY0sEDsucJnQeA&_nc_ss=7b2a8&oh=00_Af-gu2ESXEnmmi83L6x99RSXRZ2vAwc_iVahh3CxEpzuSw&oe=6A3EF448"
    },
    {
        "title": "Quạt 8 cánh màu gỗ",
        "subtitle": "Tông nâu gỗ, hợp nội thất ấm và sang",
        "image_url": "https://scontent.fhan5-6.fna.fbcdn.net/v/t45.1600-4/728532874_3412214428955052_5606934162449542415_n.jpg?_nc_cat=105&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeFDdkyqaqMM5-Od42GYHs1oha648laqL8GFrrjyVqovwZ2K2yEM2sVGjDIE9ihvZoJTeuwlmp9cPpJdEp5Ev1_r&_nc_ohc=heosDSt4O5YQ7kNvwHxIwm6&_nc_oc=Adq3bKbZRsGQjOa-04Xbl4O6r_o6yph7GM4g3s95kZ29XVNJZQyek2W_6n8hTfplruk&_nc_zt=1&_nc_ht=scontent.fhan5-6.fna&_nc_gid=XVJP-C1yMwqqDktU5JceRQ&_nc_ss=7b2a8&oh=00_Af-L4TE1d8ByLAiXF2HLYsFEbSYpkjVPxWHNu7MNadBoTg&oe=6A3F13B0"
    }
],
    faucet: [
    {
        "title": "Sen tắm, vòi, chậu rửa 01",
        "subtitle": "Mẫu thiết bị vệ sinh đẹp, phù hợp nhà tắm hiện đại",
        "image_url": "https://scontent.fhan5-10.fna.fbcdn.net/v/t39.30808-6/703191027_969113915979098_8030725390918618210_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeFa7VMnu1zyij_pDvCcZvU6CxM-YlbmHdwLEz5iVuYd3Ph9NGGH5Lt0ikG62Y373ByO0bTV7AvLIVbz5YfYWkPz&_nc_ohc=FXIstFkz2jgQ7kNvwGR7x46&_nc_oc=Adp2CFxuAzGCYDM_R3v28Nvu4YLJ6NGsOtsQCxTJB2ksW8HX5Fgh5IC0SBWYWuk_Xuc&_nc_zt=23&_nc_ht=scontent.fhan5-10.fna&_nc_gid=lw2ZNwyTAGhLXWF-rtdkWA&_nc_ss=7b2a8&oh=00_Af_EgBdj7r_WvXERm2fgzd05vy75frJVDtiEqjKEltcRug&oe=6A3F3267"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 02",
        "subtitle": "Phù hợp combo nhà tắm, lavabo, sen vòi đồng bộ",
        "image_url": "https://scontent.fhan5-8.fna.fbcdn.net/v/t39.30808-6/703434110_969113955979094_6569529519103445901_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeHH32-t5cp1HOEwtLnl4efgQhU--7nx89lCFT77ufHz2QV1yYoahgSVjwQI2-zeUAnF19mFaOZxkGYq-bgw-2hd&_nc_ohc=j9lhKFp23ucQ7kNvwHvYQhG&_nc_oc=AdpuHFpaeWpEMrFjRKfm3UV9cWafoW778nyCdhmjr4fL6UaY6WC9_OOHLGGyvgZDyYs&_nc_zt=23&_nc_ht=scontent.fhan5-8.fna&_nc_gid=2nlcgGcyzzW8UV4MhdfXGQ&_nc_ss=7b2a8&oh=00_Af8RbP_8DlRACiv4mKMStD_AoNEj9jbywVqODZk3agHO4A&oe=6A3F4C11"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 03",
        "subtitle": "Mẫu dễ phối cho phòng tắm mới hoặc cải tạo",
        "image_url": "https://scontent.fhan5-8.fna.fbcdn.net/v/t39.30808-6/706144052_969111872645969_6005742897087813212_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeGj-42sFoINEVRGYCMM1R_UKp_Y-w156xIqn9j7DXnrEmKdcMcFHXS3zI-Y2TMt6tPxyur0gAGB4wBddvWthwcn&_nc_ohc=E9kNIqp-bZQQ7kNvwEw5yxd&_nc_oc=AdqkXpglB2t7rhpnWZVBceSRhmbOumuWVt9Oo7iVGB8p3dF8Gnyy-hXCjSv3HxrNRAo&_nc_zt=23&_nc_ht=scontent.fhan5-8.fna&_nc_gid=lw2ZNwyTAGhLXWF-rtdkWA&_nc_ss=7b2a8&oh=00_Af-lY4oCbYzy5GDorhoCMILonvaSzNy-aa7bQt7-RGSX0Q&oe=6A3F4915"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 04",
        "subtitle": "Thiết bị vệ sinh đẹp, dùng cho phòng tắm gia đình",
        "image_url": "https://scontent.fhan5-10.fna.fbcdn.net/v/t39.30808-6/703762770_969115259312297_1234080936578252503_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeHE_8YJMCLPCcQYgjumiKeTgWMGOUdcXKqBYwY5R1xcquANKOQ9Uf9pMxiS4QBdADat6q0Q8SCuY6WSXdTEmm_E&_nc_ohc=ODXv-MU4eSUQ7kNvwG7uIeC&_nc_oc=AdrNUwwyDwfX_v5xCCIYW--5d5QfNzzRQB2o4hR1ZlQbS6R5srP_78Ej1zHwmfq3UVs&_nc_zt=23&_nc_ht=scontent.fhan5-10.fna&_nc_gid=2nlcgGcyzzW8UV4MhdfXGQ&_nc_ss=7b2a8&oh=00_Af_gojJu4NmULdT9o_hrC4s_jKuapV2mcdWKdqyKhgG4gA&oe=6A3F4185"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 05",
        "subtitle": "Nhiều mẫu sen vòi, chậu rửa, phụ kiện nhà tắm",
        "image_url": "https://scontent.fhan5-11.fna.fbcdn.net/v/t39.30808-6/703702032_969117399312083_6892088813610533309_n.jpg?_nc_cat=103&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeEvTWzHrIEhrIerdEc_k2iDSE2UrPzOhPFITZSs_M6E8Sk6makKCWFrEoHCr7oDfEXJvDVne13v71uXRSrzRPzj&_nc_ohc=mHj5B7Z9BL4Q7kNvwFelrTN&_nc_oc=Ados1qvWrG3HRD1sbVz3-A2XILgJkP5dmiIEJepme3MVglSvpEBAygL6eufk1lPoKws&_nc_zt=23&_nc_ht=scontent.fhan5-11.fna&_nc_gid=x8iKRicU2knMbmoxx1AlrQ&_nc_ss=7b2a8&oh=00_Af_hmtEdk1jG6IwfcGnWip7TsMXILlPdw0_EgIN5N6J3Tg&oe=6A3F202F"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 06",
        "subtitle": "Phù hợp chọn lẻ hoặc phối thành combo phòng tắm",
        "image_url": "https://scontent.fhan5-11.fna.fbcdn.net/v/t39.30808-6/703394730_969102089313614_7563853999344157562_n.jpg?_nc_cat=100&ccb=1-7&_nc_sid=127cfc&_nc_eui2=AeGvzNma-qzwKRgUIPHbS059IIw15_LYPAUgjDXn8tg8BV2Ut5nwfaeG5lp_YcacQ3Cr3QwwqDKWLc2LX4K74PzG&_nc_ohc=nmQI8xCRMDEQ7kNvwFXJeCi&_nc_oc=AdoYM8KTvfsgjVWIvqQssnfYBm1hlQrHLsK7fXayjDETX17KsiemOzMWBvsvc149PhA&_nc_zt=23&_nc_ht=scontent.fhan5-11.fna&_nc_gid=bhKe68cscEfcIRc6L2-GAw&_nc_ss=7b2a8&oh=00_Af_76vjM5pypwxqSK04aZBdo6_WdM4oOIcw5lqo7zOlg4A&oe=6A3F3660"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 07",
        "subtitle": "Dòng sen vòi, chậu rửa đẹp cho phòng tắm hiện đại",
        "image_url": "https://scontent.fhan5-8.fna.fbcdn.net/v/t39.30808-6/697199723_962937126596777_8498925046413907390_n.jpg?_nc_cat=106&ccb=1-7&_nc_sid=f727a1&_nc_eui2=AeGlX_8xtvPrub2HpN7Hzfku3fOs0Y5yUxDd86zRjnJTELZEtl4LzdKXfdSiqOoRhJ6tWcQ5P4A1etQYs76IPG63&_nc_ohc=v8W4ap3J-R8Q7kNvwE-cwga&_nc_oc=AdonMkXkkUYTM8qvwpDFjqEoJpil0dP62pjuOl75hbfslugIhe8k_pH0c4AgHcqtRQM&_nc_zt=23&_nc_ht=scontent.fhan5-8.fna&_nc_gid=94SF_MxkkrVw54j0iFlASQ&_nc_ss=7b2a8&oh=00_Af-8-ZdfJDnjjDo9_6HmC06n7lXN8lhknfBGK5jpoDPLEw&oe=6A3F2B00"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 08",
        "subtitle": "Mẫu phù hợp khách muốn chọn thiết bị đồng bộ",
        "image_url": "https://scontent.fhan5-11.fna.fbcdn.net/v/t39.30808-6/698445527_962937943263362_5571045644058564871_n.jpg?_nc_cat=103&ccb=1-7&_nc_sid=f727a1&_nc_eui2=AeFgcEY2yasUofU8BdNvLvpalsJuq_DOb4-Wwm6r8M5vj6smUIYHJoT_QSDAurTLkIRIGdMSZVqZj4w_xjbGV5Qg&_nc_ohc=bQ4bkAprWWcQ7kNvwFLqrJk&_nc_oc=AdqteoGgcC4ZC2eWLRsKE3P01FfgwUE2_YLSBtCc8JrwsK-w7BzBXHsswoeDZ_KhSH4&_nc_zt=23&_nc_ht=scontent.fhan5-11.fna&_nc_gid=5yF49pHm5e0YEaFaAKWDgg&_nc_ss=7b2a8&oh=00_Af8juSDpxk4_p1GkD8RDzR2dh1dSTfiyd78qC_1bH7O_YQ&oe=6A3F2C29"
    },
    {
        "title": "Sen tắm, vòi, chậu rửa 09",
        "subtitle": "Có thể phối cùng lavabo, bồn cầu, tủ chậu",
        "image_url": "https://scontent.fhan5-2.fna.fbcdn.net/v/t39.30808-6/698948687_962937056596784_1757048518063761369_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=f727a1&_nc_eui2=AeGL5Q10OoGXwxb9VEsfUkDBJg4_NdA8AuImDj810DwC4qnm3OY1AxUv9vaIlWs1oFtSmNKdu2hT2-aSCKW3fv7l&_nc_ohc=FasGTiiRATQQ7kNvwG3EAM5&_nc_oc=Adp5QKem01g3WYOWmHru10TtFFt_wU5NfoBlY5iI27WU6WTIM9tc7TGJ-dmHMApl_u8&_nc_zt=23&_nc_ht=scontent.fhan5-2.fna&_nc_gid=94SF_MxkkrVw54j0iFlASQ&_nc_ss=7b2a8&oh=00_Af8nmGSdK6ZHQVMBUnrklY2vyPlHe2-cVDE9wL3eLofmCg&oe=6A3F42D5"
    }
]
};

async function sendImageMessage(senderId, imageUrl, logName = "Image message") {
    // MASTER SWITCH: chặn ảnh khi tắt bot từ Admin.
    if (!isBotReplyEnabled()) {
        console.log("[BOT_REPLY_SWITCH] blocked image reply", senderId, logName || "image");
        logBlockedBotReply(senderId, `[image:${imageUrl || logName || "image"}]`, "reply_switch_off", "image", { logName, imageUrl });
        return false;
    }

    if (isBotHardPaused(senderId)) {
        const st = customerStates[String(senderId)] || {};
        console.log("AIGUKA SAFE_IMAGE blocked: human takeover active", senderId, st.humanTakeoverUntil ? new Date(Number(st.humanTakeoverUntil)).toISOString() : "");
        logBlockedBotReply(senderId, `[image:${imageUrl || logName || "image"}]`, "human_takeover_active", "image", { logName, imageUrl, humanTakeoverUntil: st.humanTakeoverUntil });
        return false;
    }

    const url = `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            recipient: { id: senderId },
            message: {
                attachment: {
                    type: "image",
                    payload: {
                        url: imageUrl,
                        is_reusable: true
                    }
                }
            }
        })
    });

    const result = await response.text();
    console.log(`${logName} status:`, response.status);
    console.log(`${logName} result:`, result);

    if (!response.ok) {
        throw new Error(`${logName} failed: ${response.status} - ${result}`);
    }

    const st = customerStates[String(senderId)] || {};
    logMessageToSupabase({
        senderId,
        pageId: st.lastPageId || "",
        role: "bot",
        text: `[image:${logName || "image"}] ${imageUrl || ""}`,
        messageType: "image",
        productGroup: toDbProductGroup(st.currentTopic || st.productType || st.lockedProduct || "") || "",
        intent: "bot_image",
        source: "bot_api_send",
        raw: { source: "bot_api_send", imageUrl, logName, facebook_status: response.status, facebook_result: result }
    }).catch(err => console.error("Supabase bot image log error:", err.message));
}

function getStaticProductItems(productType) {
    // AIGUKA 4.0.3: tuyệt đối không dùng ảnh nhóm khác làm fallback.
    // Lỗi cũ: kitchen fallback sang faucet khiến khách hỏi đồ bếp nhưng nhận sen/lavabo.
    if (productType === "combo") return PRODUCT_IMAGE_GALLERIES.combo || [];
    if (productType === "fan") return PRODUCT_IMAGE_GALLERIES.fan || [];
    if (productType === "faucet") return PRODUCT_IMAGE_GALLERIES.faucet || [];
    if (productType === "kitchen") return PRODUCT_IMAGE_GALLERIES.kitchen || [];
    if (productType === "toilet") return PRODUCT_IMAGE_GALLERIES.toilet || [];
    if (productType === "vanity") return PRODUCT_IMAGE_GALLERIES.vanity || [];
    if (productType === "kitchen_bath") {
        return (PRODUCT_IMAGE_GALLERIES.kitchen || []).slice(0, 5)
            .concat((PRODUCT_IMAGE_GALLERIES.combo || []).slice(0, 5));
    }
    return [];
}

function isAskMoreImagesMessage(message = "") {
    const msg = String(message || "").toLowerCase();
    return [
        "xem tiếp", "xem tiep", "gửi tiếp", "gui tiep", "gửi thêm", "gui them",
        "còn mẫu", "con mau", "còn ảnh", "con anh", "ảnh khác", "anh khac",
        "mẫu khác", "mau khac", "còn nữa", "con nua", "thêm mẫu", "them mau",
        "cho xem thêm", "cho xem them"
    ].some(x => msg.includes(x));
}

function aiTrace(senderId, step, data = {}) {
    try {
        const safe = JSON.stringify(data, (k, v) => {
            if (typeof v === "string" && v.length > 300) return v.slice(0, 300) + "...";
            return v;
        });
        console.log(`[AI-${step}]`, senderId || "unknown", safe);
    } catch (error) {
        console.log(`[AI-${step}]`, senderId || "unknown", data);
    }
}

function isPriceRequest(message = "") {
    const msg = String(message || "").toLowerCase();
    return [
        "giá", "gia", "bao nhiêu", "bao nhieu", "bao tiền", "bao tien",
        "báo giá", "bao gia", "giá sao", "gia sao", "giá thế nào", "gia the nao",
        "mấy tiền", "may tien", "bn", "nhiêu tiền", "nhieu tien"
    ].some(word => msg.includes(word));
}

function detectCustomerIntent(message = "") {
    const msg = normalizeIntentText(message);
    if (detectWrongProductComplaint(message)) return "wrong_product_complaint";
    if (["khong dung zalo", "k dung zalo", "khong co zalo", "khong zalo", "sao phai zalo", "o day cung duoc", "nhan o day", "tu van o day"].some(w => msg.includes(w))) return "zalo_objection";
    if (hasPhoneOrContact(message)) return "phone_provided";

    // AIGUKA 4.2.8: intent dịch vụ phải được xử lý trước sản phẩm/slide.
    // Các câu hỏi này không được rơi xuống nhánh gửi carousel.
    if (["dia chi", "o dau", "showroom", "cua hang", "map", "google map", "dinh vi", "gui dinh vi", "vi tri"].some(w => msg.includes(w))) return "ask_address";
    if (["hotline", "so dien thoai", "sdt", "so dt", "so dien thoai shop", "goi shop", "goi tu van", "lien he"].some(w => msg.includes(w))) return "ask_hotline";
    if (["gio mo cua", "may gio mo", "mo cua", "dong cua", "gio lam viec", "lam viec den may gio", "hom nay co mo cua"].some(w => msg.includes(w))) return "ask_open_hours";
    if (["bao hanh", "bh", "doi tra", "loi", "hang dat loi", "hong", "mat ra"].some(w => msg.includes(w))) return "ask_warranty";
    if (["ship", "giao", "van chuyen", "lap dat"].some(w => msg.includes(w))) return "ask_delivery";

    if (isPriceFirstObjection(message)) return "price_first";
    if (isPriceRequest(message)) return "ask_price";
    if (isAskMoreImagesMessage(message) || shouldSendCarousel(message) || isProductBrowseRequest(message)) return "ask_more_images";
    if (["chuc nang", "tinh nang", "cong dung", "tu rua", "tu xa", "say", "uv", "dieu khien", "thong so", "cau hinh"].some(w => msg.includes(w))) return "ask_features";
    if (["zalo", "za lo"].some(w => msg.includes(w))) return "ask_zalo";
    return "general";
}

function detectWrongProductComplaint(message = "") {
    const msg = normalizeIntentText(message);
    return [
        "dang hoi", "hoi", "gui sai", "nham", "khong phai", "sai roi",
        "dang hoi quat", "dang hoi bon cau", "dang hoi bep", "dang hoi tu chau",
        "toi hoi", "em hoi", "anh hoi", "chi hoi"
    ].some(w => msg.includes(w)) && Boolean(detectExplicitTopic(message));
}

function buildWrongProductRecoveryReply(productType = "") {
    const label = productLabel(productType);
    return `Dạ em xin lỗi anh/chị ạ, do bên em đang có nhiều tin nhắn từ các mẫu quảng cáo khác nhau nên hệ thống bị nhận nhầm sản phẩm. Mình đang hỏi về ${label} đúng không ạ? Anh/chị để lại SĐT/Zalo giúp em, bên em chuyển đúng mẫu ${label} và báo giá chi tiết qua Zalo để gửi đúng mẫu ạ.`;
}

function productLabel(productType = "") {
    if (productType === "fan") return "quạt trần";
    if (productType === "kitchen") return "đồ bếp";
    if (productType === "toilet") return "bồn cầu thông minh";
    if (productType === "vanity") return "tủ chậu gương/lavabo";
    if (productType === "faucet") return "sen vòi/lavabo";
    if (productType === "combo") return "combo thiết bị vệ sinh";
    return "sản phẩm này";
}

function isInstantSampleIntent(message = "") {
    return isAskMoreImagesMessage(message) || shouldSendCarousel(message) || isProductBrowseRequest(message);
}

function isNoSlideServiceIntent(intent = "") {
    return ["ask_address", "ask_hotline", "ask_open_hours", "ask_warranty", "ask_delivery"].includes(String(intent || ""));
}

function buildUnknownProductClarifyReply() {
    return "Dạ anh/chị đang quan tâm mẫu sản phẩm nào ạ? Anh/chị để lại SĐT/Zalo giúp em để showroom tư vấn và gửi đúng mẫu phù hợp nhé.";
}

function buildOpenHoursReply() {
    const st = currentWorkingSettings ? currentWorkingSettings() : {};
    const start = String(st.work_start || "08:00").slice(0, 5);
    const end = String(st.work_end || "22:00").slice(0, 5);
    return `Dạ showroom bên em thường làm việc khoảng ${start} - ${end} ạ. Anh/chị có thể gọi Hotline 0973693677 trước khi qua để bên em chuẩn bị mẫu và gửi định vị cho mình nhé.`;
}

function toDbProductGroup(productType = "") {
    const t = String(productType || "").toLowerCase();
    if (t === "fan") return "fan";
    if (t === "kitchen") return "kitchen";
    if (t === "toilet") return "toilet";
    if (t === "vanity") return "vanity";
    if (t === "faucet") return "faucet";
    if (t === "combo") return "combo";
    if (t === "kitchen_bath") return "kitchen_bath";
    return t || null;
}

function buildFeatureReply(productType) {
    if (productType === "toilet") {
        return "Dạ bồn cầu thông minh thường có các chức năng như tự xả, phun rửa, sấy khô, sưởi ấm bệ ngồi, khử mùi/UV tùy phiên bản và điều khiển từ xa ạ. Mẫu màu cam có thể khác cấu hình theo từng lô, anh/chị để lại SĐT/Zalo để bên em gửi đúng mẫu và thông số chi tiết nhé.";
    }
    if (productType === "kitchen") {
        return "Dạ đồ bếp bên em có bếp từ, hút mùi, chậu rửa bát và vòi bếp. Mỗi bộ khác nhau về mặt kính, công suất, mâm từ và bảo hành. Anh/chị muốn xem nhóm bếp từ - hút mùi hay chậu vòi bếp trước ạ?";
    }
    return "Dạ mỗi mẫu sẽ khác nhau về chất liệu, kích thước, tính năng và phân khúc giá. Anh/chị nhắn rõ mẫu đang xem hoặc để lại SĐT/Zalo, bên em gửi đúng thông số và báo giá chi tiết nhé.";
}

function isProductBrowseRequest(message = "") {
    const msg = normalizeIntentText(message);
    const hasBrowse = ["xem", "gui", "gửi", "mau", "mẫu", "anh", "ảnh", "hinh", "hình", "catalog"].some(w => msg.includes(normalizeIntentText(w)));
    return hasBrowse && Boolean(detectExplicitTopic(message));
}

async function updateSupabaseConversationMetadata(senderId, patch = {}) {
    if (!supabaseIsReady() || !senderId) return;
    try {
        const rows = await supabaseRequest(`conversations?sender_id=eq.${encodeURIComponent(String(senderId))}&status=eq.open&select=id&order=last_message_at.desc&limit=1`, { method: "GET" });
        const conv = Array.isArray(rows) ? rows[0] : null;
        if (!conv?.id) return;
        await supabaseRequest(`conversations?id=eq.${conv.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    } catch (error) {
        console.error("updateSupabaseConversationMetadata error:", error.message);
    }
}

async function updateSupabaseCustomerState(senderId, state = {}, patch = {}) {
    if (!supabaseIsReady() || !senderId) return;
    try {
        const customer = await supabaseUpsertCustomer({ senderId, pageId: state.lastPageId || "", productGroup: toDbProductGroup(state.currentTopic || state.productType || "") || "" });
        if (!customer?.id) return;
        await supabaseRequest("customer_states?on_conflict=customer_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify({
                customer_id: customer.id,
                product_lock: toDbProductGroup(state.lockedProduct || state.currentTopic || state.productType || ""),
                last_ad_id: state.lastAdId || null,
                last_post_id: state.lastPostId || null,
                welcome_slide_sent: Boolean(state.welcomeShowcases && Object.keys(state.welcomeShowcases).length),
                slide_count: Number(state.sampleSentCount || 0),
                price_sent: Boolean(state.priceSent),
                phone_requested_count: Number(state.phoneRequestedCount || state.phoneAskCount || (state.askedPhone ? 1 : 0) || 0),
                phone_detected: Boolean(state.hasContact),
                admin_taken_over: Boolean(state.humanTakeoverUntil && Date.now() < Number(state.humanTakeoverUntil)),
                bot_paused_until: state.humanTakeoverUntil ? new Date(Number(state.humanTakeoverUntil)).toISOString() : null,
                last_bot_reply: state.lastBotReply || null,
                state: { ...state, ...patch },
                updated_at: new Date().toISOString()
            })
        });
    } catch (error) {
        console.error("updateSupabaseCustomerState error:", error.message);
    }
}

function shouldHandleEchoAsHumanAdmin(event) {
    // 3.9.10: mặc định KHÔNG coi echo là admin takeover nữa.
    // Một số auto-reply/ads form của Meta cũng gửi echo và làm bot im lặng 10 phút.
    // Muốn bật lại cơ chế admin takeover qua echo thì set AIGUKA_ENABLE_HUMAN_TAKEOVER_ECHO=1.
    return process.env.AIGUKA_ENABLE_HUMAN_TAKEOVER_ECHO !== "0";
}

function productPhotoKey(productType, productRow) {
    return String(productRow?.path || productRow?.group || productType || "unknown").toLowerCase();
}

function isProbablyPublicImageUrl(url = "") {
    const u = String(url || "").trim();
    if (!/^https:\/\//i.test(u)) return false;
    // Messenger generic template không ổn định với link Google Drive dạng trang xem hoặc link local.
    if (/drive\.google\.com\/file\/d\//i.test(u) || /drive\.google\.com\/open\?/i.test(u)) return false;
    return true;
}

function buildMessengerElements(items, titlePrefix = "Mẫu") {
    return (items || []).slice(0, 10).map((item, idx) => ({
        title: String(item.title || item.name || `${titlePrefix} ${idx + 1}`).slice(0, 80),
        subtitle: "Mẫu tiêu biểu bên em, anh/chị bấm gọi hoặc để lại Zalo để sale gửi thêm.",
        image_url: item.image_url,
        buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
    })).filter(x => isProbablyPublicImageUrl(x.image_url));
}

function productScopeTerms(productType = "") {
    const t = String(productType || "").toLowerCase();
    if (t === "kitchen") return ["bếp", "bep", "hút mùi", "hut mui", "chậu rửa bát", "chau rua bat", "vòi bếp", "voi bep", "kitchen", "yamato", "bếp từ", "bep tu"];
    if (t === "fan") return ["quạt", "quat", "fan", "cánh", "canh", "guka"];
    if (t === "toilet") return ["bồn cầu", "bon cau", "toilet", "wc", "bệt", "bet", "thông minh", "thong minh"];
    if (t === "vanity") return ["tủ chậu", "tu chau", "tủ lavabo", "tu lavabo", "gương", "guong", "vanity"];
    if (t === "faucet") return ["sen", "vòi", "voi", "lavabo", "chậu rửa", "chau rua", "faucet"];
    if (t === "combo") return ["combo", "phòng tắm", "phong tam", "thiết bị vệ sinh", "thiet bi ve sinh", "bathroom"];
    return [];
}

function productNegativeScopeTerms(productType = "") {
    const t = String(productType || "").toLowerCase();
    if (t === "kitchen") return ["sen", "lavabo", "bồn cầu", "bon cau", "phòng tắm", "phong tam", "tủ chậu", "tu chau", "gương", "guong", "combo"];
    if (t === "toilet") return ["bếp", "bep", "hút mùi", "hut mui", "quạt", "quat", "sen tắm", "sen tam", "tủ chậu", "tu chau"];
    if (t === "fan") return ["bếp", "bep", "sen", "lavabo", "bồn cầu", "bon cau", "tủ chậu", "tu chau"];
    return [];
}

function itemTextForScope(item = {}) {
    return normalizeIntentText([item.title, item.name, item.subtitle, item.path, item.webViewLink].filter(Boolean).join(" "));
}

function filterProductItemsByScope(items = [], productType = "") {
    const list = Array.isArray(items) ? items : [];
    const t = String(productType || "").toLowerCase();
    if (!t || ["combo", "kitchen_bath"].includes(t)) return list;

    const positives = productScopeTerms(t).map(normalizeIntentText).filter(Boolean);
    const negatives = productNegativeScopeTerms(t).map(normalizeIntentText).filter(Boolean);

    const strict = list.filter(item => {
        const txt = itemTextForScope(item);
        if (!txt) return false;
        if (negatives.some(w => txt.includes(w))) return false;
        return positives.some(w => txt.includes(w));
    });

    // Nếu lọc strict ra kết quả thì dùng. Nếu không, chỉ trả về nguyên list khi nguồn là productRow path cụ thể.
    // Với static fallback, list sai nhóm sẽ bị chặn từ getStaticProductItems.
    return strict.length ? strict : list;
}

async function loadProductMediaItems(productType, productRow) {
    let items = [];
    if (productRow?.path) {
        try {
            items = await listProductImagesByPath(productRow.path);
        } catch (error) {
            console.error("Drive image list error:", productRow.path, error.message);
        }
    }
    if (!items || !items.length) items = getStaticProductItems(productType);
    items = filterProductItemsByScope(items || [], productType);
    return items || [];
}

function buildAfterSlide2Close(productType = "", inOffice = isOfficeHoursVN()) {
    return buildPostSlideReply(productType, inOffice);
}

function buildPostSlideReply(productType = "", inOffice = isOfficeHoursVN()) {
    const label = productLabel(productType);

    if (!inOffice) {
        return `Dạ em gửi anh/chị một số mẫu ${label} bán chạy để mình tham khảo trước ạ. Nếu cần báo giá chi tiết hoặc xem thêm nhiều mẫu phù hợp, anh/chị để lại SĐT/Zalo, showroom sẽ liên hệ tư vấn sớm nhất khi vào giờ làm việc nhé.`;
    }

    if (productType === "fan") {
        return "Dạ bên em có nhiều mẫu quạt trần với kiểu dáng, màu sắc, kích thước và động cơ khác nhau. Anh/chị để lại SĐT/Zalo, sale bên em sẽ gửi đúng mẫu phù hợp với không gian nhà mình và báo giá chi tiết nhé.";
    }
    if (productType === "toilet") {
        return "Dạ bên em có nhiều mẫu bồn cầu thông minh với các tính năng và mức giá khác nhau. Anh/chị để lại SĐT/Zalo, sale bên em sẽ gửi đúng mẫu phù hợp và báo giá chi tiết cho mình nhé.";
    }
    if (productType === "vanity") {
        return "Dạ tủ chậu/lavabo bên em có nhiều kích thước, màu sắc và chất liệu khác nhau. Anh/chị để lại SĐT/Zalo, sale bên em sẽ gửi đúng mẫu phù hợp với không gian phòng tắm và báo giá chi tiết nhé.";
    }
    if (productType === "faucet") {
        return "Dạ bên em có nhiều mẫu sen vòi, lavabo và chậu vòi từ phổ thông đến cao cấp. Anh/chị để lại SĐT/Zalo, sale bên em sẽ gửi đúng mẫu phù hợp và báo giá chi tiết nhé.";
    }
    if (productType === "kitchen") {
        return "Dạ đồ bếp bên em có nhiều mẫu bếp từ, hút mùi, chậu rửa và vòi bếp theo từng phân khúc. Anh/chị để lại SĐT/Zalo, sale bên em sẽ gửi đúng mẫu phù hợp với nhu cầu và báo giá chi tiết nhé.";
    }
    if (productType === "combo" || productType === "kitchen_bath") {
        return "Dạ bên em có nhiều mẫu combo phòng tắm ở nhiều mức giá khác nhau, từ phổ thông đến cao cấp ạ. Anh/chị để lại SĐT/Zalo, sale bên em sẽ gửi đúng mẫu phù hợp với nhu cầu và báo giá chi tiết cho mình nhé.";
    }

    return `Dạ bên em có nhiều mẫu ${label} ở nhiều phân khúc khác nhau. Anh/chị để lại SĐT/Zalo, sale bên em sẽ gửi đúng mẫu phù hợp và báo giá chi tiết cho mình nhé.`;
}

async function sendProductMediaByRule(senderId, productType, productRow, state, customerMessage = "") {
    const explicitItem = detectProductItemFromText(customerMessage, productType) || findProductItemByKey(state?.productItemKey || "");
    if (explicitItem) {
        const elements = await buildProductItemElements(explicitItem, 10);
        if (elements.length) {
            await sendTemplate(senderId, elements, `Product item slide ${explicitItem.product_item_key}`);
            if (!state.photoMemory || typeof state.photoMemory !== "object") state.photoMemory = {};
            state.photoMemory[explicitItem.product_item_key] = { stage: 1, sentCount: elements.length, total: elements.length, updatedAt: Date.now() };
            state.productItemKey = explicitItem.product_item_key;
            return { sent: true, mode: "product_item_drive_folder", sentCount: elements.length, total: elements.length, final: true, product_item_key: explicitItem.product_item_key };
        }
    }
    const items = await loadProductMediaItems(productType, productRow);
    if (!items.length) return { sent: false, reason: "no_images" };

    if (!state.photoMemory || typeof state.photoMemory !== "object") state.photoMemory = {};
    const key = productPhotoKey(productType, productRow);
    const memory = state.photoMemory[key] || { stage: 0, sentCount: 0 };
    const wantsMore = isAskMoreImagesMessage(customerMessage);

    // PHOTO_RULE V2.0:
    // 1-4 ảnh: gửi toàn bộ ảnh lẻ một lần. Nếu khách hỏi tiếp sau khi đã xem hết thì không gửi lặp.
    if (items.length <= 4) {
        if (memory.stage >= 2 && wantsMore) {
            await sendMessage(senderId, buildAfterSlide2Close(productType, isOfficeHoursVN()));
            return { sent: true, mode: "closed", sentCount: 0, total: items.length, final: true, needClose: false };
        }
        for (const item of items) await sendImageMessage(senderId, item.image_url, `Image ${productType} - ${item.title || item.name || "photo"}`);
        state.photoMemory[key] = { stage: 2, sentCount: items.length, total: items.length, updatedAt: Date.now() };
        return { sent: true, mode: "images", sentCount: items.length, total: items.length, final: true };
    }

    // Nếu đã gửi slide 1 và khách xin xem tiếp: mỗi lần chỉ gửi một slide mới, không trùng.
    // Lần xin thêm thứ 3 trở đi: không gửi ảnh nữa, ép sang SĐT/Zalo.
    if (wantsMore && memory.stage >= 1) {
        const moreAskCount = Number(memory.moreAskCount || 0) + 1;
        if (moreAskCount >= 3) {
            await sendMessage(senderId, buildAfterSlide2Close(productType, isOfficeHoursVN()));
            state.photoMemory[key] = { ...memory, stage: 3, moreAskCount, sentCount: Number(memory.sentCount || 0), total: items.length, updatedAt: Date.now() };
            return { sent: true, mode: "closed_after_third_more", sentCount: 0, total: items.length, final: true, needClose: false };
        }

        const start = Number(memory.sentCount || 10);
        const chunk = items.slice(start, start + 10);
        if (!chunk.length) {
            await sendMessage(senderId, buildAfterSlide2Close(productType, isOfficeHoursVN()));
            state.photoMemory[key] = { ...memory, stage: 3, moreAskCount, sentCount: start, total: items.length, updatedAt: Date.now() };
            return { sent: true, mode: "closed_no_more_images", sentCount: 0, total: items.length, final: true };
        }

        const elements = buildMessengerElements(chunk, productRow?.group || "Mẫu");
        if (elements.length) await sendTemplate(senderId, elements, `Product slide more ${moreAskCount} ${productType}`);

        const newSentCount = Math.min(start + elements.length, items.length);
        state.photoMemory[key] = { stage: 1, moreAskCount, sentCount: newSentCount, total: items.length, updatedAt: Date.now() };
        return { sent: true, mode: `slide_more_${moreAskCount}`, sentCount: elements.length, total: items.length, final: newSentCount >= items.length, needClose: moreAskCount >= 2 || newSentCount >= items.length };
    }

    // Từ 5 ảnh trở lên: gửi Slide 1, 5-10 ảnh.
    const firstCount = Math.min(10, Math.max(5, Math.min(items.length, 10)));
    const elements = buildMessengerElements(items.slice(0, firstCount), productRow?.group || "Mẫu");
    if (elements.length) await sendTemplate(senderId, elements, `Product slide 1 ${productType}`);
    state.photoMemory[key] = { stage: 1, sentCount: firstCount, total: items.length, updatedAt: Date.now() };
    return { sent: true, mode: "slide1", sentCount: firstCount, total: items.length, final: items.length <= firstCount };
}

async function sendImageGalleryByProduct(senderId, productType, limit = 4) {
    const items = getStaticProductItems(productType);
    if (!items || items.length === 0) return false;
    const selected = items.slice(0, limit);
    for (const item of selected) await sendImageMessage(senderId, item.image_url, `Image ${productType} - ${item.title}`);
    return true;
}

async function sendCarouselByProduct(senderId, productType, productRow = null, state = {}, customerMessage = "") {
    const result = await sendProductMediaByRule(senderId, productType, productRow, state, customerMessage);
    return Boolean(result && result.sent) ? result : { sent: false };
}



function countCustomerTurns(history) {
    if (!Array.isArray(history)) return 0;
    return history.filter(line => String(line).startsWith("Khách:")).length;
}

function shouldAskPhoneNow(customerMessage, state, history) {
    if (!state) return false;
    if (state.hasContact) return false;
    if (state.phoneRejected || state.preferMessenger) return false;

    const msg = String(customerMessage || "").toLowerCase();
    const turns = countCustomerTurns(history);

    const buyingSignals = [
        "giá", "gia", "bao nhiêu", "bao nhieu", "báo giá", "bao gia",
        "mua", "có loại", "co loai", "lấy", "lay", "đặt", "dat",
        "giao", "ship", "ở đâu", "o dau", "còn không", "con khong"
    ];

    const hasBuyingSignal = buyingSignals.some(word => msg.includes(word));

    // Sau 2 lượt khách có tín hiệu mua/hỏi giá thì xin số nhẹ.
    if (turns >= 2 && hasBuyingSignal) return true;

    // Sau 3 lượt khách vẫn chưa để số thì xin số nhẹ để nhân viên tư vấn sâu.
    if (turns >= 3) return true;

    return false;
}

function buildPhoneAskByTopic(productType) {
    if (productType === "fan") {
        return "Anh để lại SĐT/Zalo giúp em, bên em gửi thêm mẫu quạt đúng nhu cầu và báo giá chi tiết nhanh hơn nhé?";
    }

    if (productType === "vanity") {
        return "Anh/chị để lại SĐT/Zalo giúp em, bên em gửi thêm mẫu tủ chậu gương/tủ lavabo theo kích thước phòng tắm và báo giá chi tiết nhanh hơn nhé?";
    }

    if (productType === "combo" || productType === "faucet" || productType === "kitchen" || productType === "kitchen_bath") {
        return "Anh để lại SĐT/Zalo giúp em, bên em gửi thêm mẫu phù hợp ngân sách và báo giá chi tiết theo bộ nhanh hơn nhé?";
    }

    return "Anh để lại SĐT/Zalo giúp em, bên em gửi thêm mẫu và báo giá chi tiết nhanh hơn nhé?";
}


function isBrandQuestion(customerMessage) {
    const msg = String(customerMessage || "").toLowerCase();
    return [
        "hãng nào", "hang nao", "thương hiệu", "thuong hieu",
        "của hãng", "cua hang", "hãng gì", "hang gi",
        "sản xuất", "san xuat", "xuất xứ", "xuat xu",
        "nước nào", "nuoc nao", "made in"
    ].some(word => msg.includes(word));
}

function buildBrandReply(productType) {
    if (productType === "fan") {
        return "Dạ quạt bên em có thương hiệu riêng GUKA, nhiều phiên bản từ cơ bản đến cao cấp, có bản động cơ Nhật/Ý. Nếu anh cần đúng mẫu và báo giá, anh để lại SĐT/Zalo để chuyên viên gửi catalogue và tư vấn nhanh hơn ạ.";
    }

    if (productType === "combo" || productType === "faucet" || productType === "vanity" || productType === "kitchen_bath") {
        return "Dạ thiết bị vệ sinh bên em phân phối nhiều hãng như TOTO, INAX, Viglacera, Huge, Caesar... và có thương hiệu riêng GUKA. Riêng tủ chậu gương/tủ lavabo có nhiều mẫu phối theo kích thước phòng tắm. Anh cần xem hãng nào hoặc tầm giá nào ạ? Nếu tiện anh để lại SĐT/Zalo, chuyên viên sẽ gửi đúng mẫu và báo giá nhanh hơn ạ.";
    }

    if (productType === "kitchen") {
        return "Dạ thiết bị bếp bên em có nhiều thương hiệu và phân khúc khác nhau, ngoài ra có các mẫu phối đồng bộ theo nhu cầu. Anh cần xem nhóm bếp từ, hút mùi hay chậu vòi ạ? Nếu tiện anh để lại SĐT/Zalo để chuyên viên gửi đúng mẫu và báo giá nhanh hơn ạ.";
    }

    return "Dạ bên em phân phối nhiều thương hiệu lớn như TOTO, INAX, Viglacera, Huge, Caesar... và có thương hiệu riêng GUKA. Anh cần xem hãng nào hoặc tầm giá nào ạ?";
}

function isToiletOnlyQuestion(customerMessage) {
    const msg = normalizeIntentText(customerMessage || "");
    const toiletWords = ["bon cau", "bon cau thong minh", "bon cau ai", "cau thong minh", "bet", "bon ve sinh", "toilet", "wc", "lien khoi", "tu rua", "tu phun", "uv", "dieu khien giong noi"];
    const comboWords = ["combo", "phong tam", "nha tam", "thiet bi ve sinh"];
    return toiletWords.some(word => msg.includes(word)) && !comboWords.some(word => msg.includes(word));
}

function buildToiletSampleFallback() {
    return buildSmartToiletReply();
}

function buildContactHandoverReply(customerMessage, state) {
    const msg = String(customerMessage || "").toLowerCase();

    if (isBrandQuestion(msg)) {
        if ((state.currentTopic || state.productType) === "fan") {
            return "Dạ quạt bên em có thương hiệu riêng GUKA, có dòng cơ bản đến cao cấp và bản động cơ Nhật/Ý. Em đã có SĐT/Zalo của anh rồi, chuyên viên sẽ gọi lại để gửi đúng mẫu và báo giá chi tiết ạ.";
        }

        return "Dạ thiết bị vệ sinh bên em có TOTO, INAX, Viglacera, Huge, Caesar... và thương hiệu riêng GUKA. Em đã có SĐT/Zalo của anh rồi, chuyên viên sẽ gọi lại để gửi đúng mẫu và báo giá chi tiết ạ.";
    }

    if (msg.includes("giá") || msg.includes("gia") || msg.includes("bao nhiêu") || msg.includes("bao nhieu") || msg.includes("báo giá") || msg.includes("bao gia")) {
        return "Dạ bên em đã nhận được SĐT/Zalo của anh rồi. Chuyên viên sẽ gọi lại để báo đúng mẫu, đúng giá và gửi catalogue chi tiết, tránh Messenger quảng cáo bị trôi tin ạ.";
    }

    if (msg.includes("mẫu") || msg.includes("mau") || msg.includes("ảnh") || msg.includes("hình") || msg.includes("hinh") || msg.includes("catalog")) {
        return "Dạ em đã nhận được SĐT/Zalo của anh rồi. Chuyên viên sẽ gửi catalogue/mẫu qua Zalo và gọi tư vấn trực tiếp để anh dễ chọn hơn ạ.";
    }

    return "Dạ em đã nhận được SĐT/Zalo của anh rồi. Chuyên viên sẽ chủ động liên hệ tư vấn chi tiết trong thời gian sớm nhất ạ.";
}

function isProbablyUnsupportedProduct(customerMessage, state) {
    const msg = String(customerMessage || "").toLowerCase();
    if (detectExplicitTopic(msg)) return false;

    const askWords = ["giá", "gia", "báo giá", "bao gia", "mẫu", "mau", "ảnh", "hình", "xem", "có loại", "co loai"];
    const mentionsAsk = askWords.some(word => msg.includes(word));

    if (!mentionsAsk) return false;

    // Nếu đang có chủ đề cũ thì không coi là unsupported, vì khách có thể nói "gửi ảnh", "báo giá".
    if (state && state.currentTopic) return false;

    return true;
}

function buildUnsupportedProductReply() {
    return "Dạ sản phẩm này em cần kiểm tra lại đúng mẫu và tình trạng hàng để tránh báo sai ạ. Anh để lại SĐT/Zalo hoặc gửi rõ tên/ảnh sản phẩm, bên em kiểm tra rồi báo lại chính xác cho anh nhé?";
}


// ================= AIGUKA 4.0 SALES WORKFLOW ENGINE =================
// Nguyên tắc: code quyết định workflow, GPT chỉ dùng cho trường hợp thật sự cần diễn đạt tự do.

function getVietnamHour(date = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Ho_Chi_Minh",
            hour: "2-digit",
            hour12: false
        }).formatToParts(date);
        const hour = Number((parts.find(p => p.type === "hour") || {}).value || 0);
        return Number.isFinite(hour) ? hour : date.getUTCHours() + 7;
    } catch (error) {
        return (date.getUTCHours() + 7) % 24;
    }
}

function isOfficeHoursVN(time = Date.now()) {
    return isBotOpenBySettings(time);
}

function getBotDelayMs(time = Date.now()) {
    const st = currentWorkingSettings();
    const inOffice = isOfficeHoursVN(time);
    const minutes = inOffice ? Number(st.admin_pause_minutes || st.customer_wait_minutes || 10) : Number(st.outside_wait_minutes || st.customer_wait_minutes || 5);
    return Math.max(0, minutes) * 60 * 1000;
}

function clearCustomerReplyTimer(senderId) {
    const timer = customerReplyTimers.get(senderId);
    if (timer) clearTimeout(timer);
    customerReplyTimers.delete(senderId);
}

function normalizeAdText(value = "") {
    return normalizeIntentText(String(value || ""));
}

function productFromAdText(text = "") {
    const msg = normalizeAdText(text);
    if (!msg) return null;
    if (["quat", "quat tran", "quat den", "guka", "10 canh", "8 canh", "fan"].some(w => msg.includes(w))) return "fan";
    if (["bon cau", "cau thong minh", "toilet", "wc", "bet", "bon cau thong minh"].some(w => msg.includes(w))) return "toilet";
    if (["tu chau", "tu lavabo", "guong lavabo", "tu chau guong", "vanity"].some(w => msg.includes(w))) return "vanity";
    if (["bep", "do bep", "bep tu", "hut mui", "chau rua bat", "kitchen"].some(w => msg.includes(w))) return "kitchen";
    if (["sen", "voi", "lavabo", "chau rua", "faucet"].some(w => msg.includes(w))) return "faucet";
    if (["thiet bi ve sinh", "tbvs", "combo", "phong tam", "nha tam", "bathroom"].some(w => msg.includes(w))) return "combo";
    return null;
}


// ===== AIGUKA 4.2 AD MAPPING ADMIN =====
// Nguồn sự thật để bot nhận diện quảng cáo: Supabase.ad_mappings.
// Khi server restart, bot nạp bảng này vào RAM. Nếu Supabase tạm lỗi, bot vẫn dùng cache local/env cũ.
const AD_MAPPING_TABLE = process.env.AD_MAPPING_TABLE || "ad_mappings";
let adMappingCache = { byKey: {}, rows: [], loadedAt: null, source: "empty" };


// ===== AIGUKA 4.2.3 PRODUCT ITEM CATALOG + WORKING SETTINGS =====
// product_items: quản lý slide theo từng sản phẩm/folder Drive, không chỉ theo nhóm lớn.
// bot_working_settings: đưa giờ làm việc và thời gian chờ lên Supabase để đổi linh hoạt.
const PRODUCT_ITEMS_TABLE = process.env.PRODUCT_ITEMS_TABLE || "product_items";
const WORKING_SETTINGS_TABLE = process.env.WORKING_SETTINGS_TABLE || "bot_working_settings";

const PRODUCT_GROUP_ALIASES = {
    bathroom: "combo",
    tbvs: "combo",
    thiet_bi_ve_sinh: "combo",
    kitchen_bath: "combo"
};

function normalizeProductGroup(value = "") {
    const v = normalizeProductAlias(value) || normalizeAdText(value) || "unknown";
    return PRODUCT_GROUP_ALIASES[v] || v;
}

const PRODUCT_ITEM_SEED_ROWS = [
    { product_group: "combo", product_item_key: "vanity_mirror", product_item_name: "Tủ chậu gương", drive_folder: "tủ chậu gương", aliases: "tủ chậu gương,tu chau guong,tủ lavabo,tu lavabo,tủ chậu,tu chau,gương tủ,guong tu", welcome_order: 10, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "premium_faucet", product_item_name: "Sen vòi cao cấp", drive_folder: "Sen vòi cao cấp", aliases: "sen vòi cao cấp,sen voi cao cap,sen tắm cao cấp,sen tam cao cap", welcome_order: 20, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "faucet_01", product_item_name: "Sen vòi 01", drive_folder: "Sen vòi 01", aliases: "sen vòi 01,sen voi 01,sen vòi,sen voi,sen tắm,sen tam,vòi,voi", welcome_order: 30, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "lavabo", product_item_name: "Lavabo", drive_folder: "Lavabo", aliases: "lavabo,chậu lavabo,chau lavabo,chậu rửa mặt,chau rua mat,bồn rửa mặt,bon rua mat", welcome_order: 40, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "bathroom_combo_new", product_item_name: "Combo phòng tắm đẹp mới", drive_folder: "Combo phòng tắm đẹp mới", aliases: "combo phòng tắm đẹp mới,combo phong tam dep moi,combo phòng tắm,combo phong tam,bộ phòng tắm,bo phong tam", welcome_order: 50, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "bathroom_combo_bestseller", product_item_name: "Combo phòng tắm bán chạy", drive_folder: "Combo phòng tắm bán chạy", aliases: "combo phòng tắm bán chạy,combo phong tam ban chay,bộ bán chạy,bo ban chay", welcome_order: 60, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "massage_bathtub", product_item_name: "Bồn tắm massage", drive_folder: "Bồn tắm massage", aliases: "bồn tắm massage,bon tam massage,bồn massage,bon massage", welcome_order: 70, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "bathtub", product_item_name: "Bồn tắm", drive_folder: "Bồn tắm", aliases: "bồn tắm,bon tam,bathtub", welcome_order: 80, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "one_piece_toilet", product_item_name: "Bồn cầu liền khối", drive_folder: "Bồn cầu liền khối", aliases: "bồn cầu liền khối,bon cau lien khoi,bệt liền khối,bet lien khoi,bệt thường,bet thuong", welcome_order: 90, images_per_welcome: 3, is_active: true },
    { product_group: "combo", product_item_key: "smart_toilet", product_item_name: "Bồn cầu trứng, thông minh", drive_folder: "Bồn cầu trứng, thông minh", aliases: "bồn cầu trứng,bon cau trung,bồn cầu thông minh,bon cau thong minh,bồn cầu ai,bon cau ai,bệt ai,bet ai,toilet thông minh,toilet thong minh,wc thông minh,wc thong minh", welcome_order: 100, images_per_welcome: 3, is_active: true },
    { product_group: "fan", product_item_key: "fan_general", product_item_name: "Quạt trần đèn GUKA", drive_folder: "Quạt", aliases: "quạt,quat,quạt trần,quat tran,quạt đèn,quat den,guka,10 cánh,10 canh,8 cánh,8 canh,5 cánh,5 canh", welcome_order: 10, images_per_welcome: 3, is_active: true },
    { product_group: "kitchen", product_item_key: "induction_stove", product_item_name: "Bếp từ", drive_folder: "Bếp từ", aliases: "bếp từ,bep tu,bếp điện,bep dien", welcome_order: 10, images_per_welcome: 3, is_active: true },
    { product_group: "kitchen", product_item_key: "range_hood", product_item_name: "Máy hút mùi", drive_folder: "Hút mùi", aliases: "hút mùi,hut mui,máy hút mùi,may hut mui", welcome_order: 20, images_per_welcome: 3, is_active: true },
    { product_group: "kitchen", product_item_key: "kitchen_sink", product_item_name: "Chậu rửa bát", drive_folder: "Chậu rửa bát", aliases: "chậu rửa bát,chau rua bat,chậu bếp,chau bep", welcome_order: 30, images_per_welcome: 3, is_active: true },
    { product_group: "kitchen", product_item_key: "kitchen_faucet", product_item_name: "Vòi bếp", drive_folder: "Vòi bếp", aliases: "vòi bếp,voi bep,vòi rửa bát,voi rua bat", welcome_order: 40, images_per_welcome: 3, is_active: true },
    { product_group: "lighting", product_item_key: "decor_lighting", product_item_name: "Đèn trang trí", drive_folder: "Đèn", aliases: "đèn,den,đèn trang trí,den trang tri,đèn chùm,den chum", welcome_order: 10, images_per_welcome: 3, is_active: true }
];

let productItemsCache = { rows: [], byKey: {}, loadedAt: null, source: "empty" };
let workingSettingsCache = {
    loadedAt: null,
    source: "default",
    setting_key: "default",
    timezone: "Asia/Ho_Chi_Minh",
    work_start: "08:00",
    work_end: "22:00",
    is_open: true,
    holiday_mode: false,
    staff_online_count: 1,
    admin_pause_minutes: 10,
    customer_wait_minutes: 5,
    outside_wait_minutes: 5,
    carousel_cooldown_minutes: 5,
    note: ""
};

function normalizeProductItemRow(row = {}) {
    const productGroup = normalizeProductGroup(row.product_group || row.group || row.productType || "combo");
    const key = normalizeAdText(row.product_item_key || row.item_key || row.key || row.product_item_name || row.name || "").replace(/\s+/g, "_");
    let aliases = row.aliases || row.alias || row.keywords || "";
    if (Array.isArray(aliases)) aliases = aliases.join(",");
    const name = String(row.product_item_name || row.name || row.title || key || "Sản phẩm").trim();
    return {
        id: row.id || null,
        product_group: productGroup,
        product_item_key: key,
        product_item_name: name,
        drive_folder: String(row.drive_folder || row.drive_folder_name || row.folder || name).trim(),
        aliases: String(aliases || "").trim(),
        welcome_order: Number(row.welcome_order || row.sort_order || 999),
        images_per_welcome: Math.max(1, Math.min(10, Number(row.images_per_welcome || 3))),
        is_active: row.is_active === false || row.enabled === false ? false : true,
        notes: String(row.notes || "").trim()
    };
}

function indexProductItems(rows = []) {
    const byKey = {};
    for (const raw of rows) {
        const row = normalizeProductItemRow(raw);
        if (row.product_item_key) byKey[row.product_item_key] = row;
    }
    return byKey;
}

async function loadProductItemsFromSupabase() {
    if (!supabaseIsReady()) {
        productItemsCache = { rows: PRODUCT_ITEM_SEED_ROWS.map(normalizeProductItemRow), byKey: indexProductItems(PRODUCT_ITEM_SEED_ROWS), loadedAt: new Date().toISOString(), source: "seed_no_supabase" };
        return productItemsCache;
    }
    try {
        const rows = await supabaseRequest(`${PRODUCT_ITEMS_TABLE}?select=*&is_active=eq.true&order=product_group.asc,welcome_order.asc&limit=5000`, { method: "GET" });
        const finalRows = Array.isArray(rows) && rows.length ? rows.map(normalizeProductItemRow) : PRODUCT_ITEM_SEED_ROWS.map(normalizeProductItemRow);
        productItemsCache = { rows: finalRows, byKey: indexProductItems(finalRows), loadedAt: new Date().toISOString(), source: Array.isArray(rows) && rows.length ? "supabase" : "seed_empty_supabase" };
    } catch (error) {
        console.error("[PRODUCT_ITEMS] load error:", error.message);
        if (!productItemsCache.rows.length) productItemsCache = { rows: PRODUCT_ITEM_SEED_ROWS.map(normalizeProductItemRow), byKey: indexProductItems(PRODUCT_ITEM_SEED_ROWS), loadedAt: new Date().toISOString(), source: "seed_after_error" };
    }
    return productItemsCache;
}

function parseClockMinutes(value = "08:00") {
    const m = String(value || "").match(/(\d{1,2}):(\d{2})/);
    if (!m) return 8 * 60;
    const hh = Math.max(0, Math.min(23, Number(m[1])));
    const mm = Math.max(0, Math.min(59, Number(m[2])));
    return hh * 60 + mm;
}

function getVietnamMinutes(date = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
        const hour = Number((parts.find(p => p.type === "hour") || {}).value || 0);
        const minute = Number((parts.find(p => p.type === "minute") || {}).value || 0);
        return hour * 60 + minute;
    } catch (_) {
        const d = new Date(date.getTime() + 7 * 60 * 60 * 1000);
        return d.getUTCHours() * 60 + d.getUTCMinutes();
    }
}

async function loadWorkingSettingsFromSupabase() {
    if (!supabaseIsReady()) return workingSettingsCache;
    try {
        const rows = await supabaseRequest(`${WORKING_SETTINGS_TABLE}?setting_key=eq.default&select=*&limit=1`, { method: "GET" });
        if (Array.isArray(rows) && rows[0]) {
            const r = rows[0];
            workingSettingsCache = {
                ...workingSettingsCache,
                ...r,
                is_open: r.is_open !== false,
                holiday_mode: Boolean(r.holiday_mode),
                admin_pause_minutes: Math.max(1, Number(r.admin_pause_minutes || 10)),
                customer_wait_minutes: Math.max(0, Number(r.customer_wait_minutes || 5)),
                outside_wait_minutes: Math.max(0, Number(r.outside_wait_minutes || r.customer_wait_minutes || 5)),
                carousel_cooldown_minutes: Math.max(1, Number(r.carousel_cooldown_minutes || 5)),
                loadedAt: new Date().toISOString(),
                source: "supabase"
            };
        }
    } catch (error) {
        console.error("[WORKING_SETTINGS] load error:", error.message);
    }
    return workingSettingsCache;
}

function currentWorkingSettings() {
    return workingSettingsCache || {};
}

function isBotOpenBySettings(time = Date.now()) {
    const st = currentWorkingSettings();
    if (st.is_open === false) return false;
    const nowMin = getVietnamMinutes(new Date(time));
    const start = parseClockMinutes(st.work_start || "08:00");
    const end = parseClockMinutes(st.work_end || "22:00");
    if (start === end) return true;
    if (start < end) return nowMin >= start && nowMin < end;
    return nowMin >= start || nowMin < end;
}

function groupMatches(a = "", b = "") {
    const ga = normalizeProductGroup(a);
    const gb = normalizeProductGroup(b);
    return ga === gb || (ga === "combo" && gb === "bathroom") || (ga === "bathroom" && gb === "combo");
}

function productItemCandidatesForGroup(productGroup = "") {
    const g = normalizeProductGroup(productGroup || "combo");
    return (productItemsCache.rows || [])
        .filter(x => x.is_active !== false && groupMatches(x.product_group, g))
        .sort((a, b) => Number(a.welcome_order || 999) - Number(b.welcome_order || 999));
}

function findProductItemByKey(key = "") {
    const k = normalizeAdText(key).replace(/\s+/g, "_");
    return productItemsCache.byKey?.[k] || null;
}

function detectProductItemFromText(text = "", productGroup = "") {
    const msg = normalizeIntentText(text || "");
    if (!msg) return null;
    const candidates = productGroup ? productItemCandidatesForGroup(productGroup) : (productItemsCache.rows || []);
    let best = null;
    let bestScore = 0;
    for (const item of candidates) {
        const terms = [item.product_item_name, item.product_item_key, item.drive_folder, item.aliases]
            .filter(Boolean).join(",").split(/[,;|\n]+/).map(normalizeIntentText).filter(x => x && x.length >= 2);
        let score = 0;
        for (const term of terms) {
            if (msg.includes(term)) score += Math.min(10, term.length) + (term.split(" ").length > 1 ? 4 : 0);
        }
        if (score > bestScore) { best = item; bestScore = score; }
    }
    return bestScore > 0 ? best : null;
}

function productItemLabel(item) {
    return item?.product_item_name || item?.drive_folder || item?.product_item_key || "sản phẩm";
}

function buildDirectProductChoiceText() {
    // 4.2.8: không xổ list sản phẩm, không gửi slide khi chưa rõ sản phẩm.
    return buildUnknownProductClarifyReply();
}


function shouldAskProductChoice(event = {}, state = {}, productType = "", customerMessage = "") {
    // AIGUKA 4.2.5: bỏ hẳn câu hỏi list sản phẩm dài.
    // Lỗi thực tế: khách đến từ QC quạt nhưng bot vẫn xổ danh sách toàn ngành hàng.
    // Nếu chưa xác định được sản phẩm, bot chỉ hỏi ngắn ở nhánh fallback, không gửi list.
    return false;
}

function groupFromNumericChoice(message = "") {
    const msg = normalizeIntentText(message || "").trim();
    if (/^1\b/.test(msg)) return "fan";
    if (/^2\b/.test(msg)) return "combo";
    if (/^3\b/.test(msg)) return "kitchen";
    if (/^4\b/.test(msg)) return "toilet";
    if (/^5\b/.test(msg)) return "vanity";
    if (/^6\b/.test(msg)) return "faucet";
    if (/^7\b/.test(msg)) return "lighting";
    return null;
}

const AD_MAPPING_SEED_ROWS = [
    { ad_account_id: "972318199015585", campaign_id: "120244323248080424", campaign_name: "Quạt GUKA", adset_id: "120244325500240424", adset_name: "Quạt Tổng Hợp", ad_id: "120244325500230424", ad_name: "Quạt Tổng Hợp 01", effective_status: "ACTIVE", product_group: "fan", slide_key: "FAN_LIGHT_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "972318199015585", campaign_id: "120244323248080424", campaign_name: "Quạt GUKA", adset_id: "120244325500240424", adset_name: "Quạt Tổng Hợp", ad_id: "120244584024930424", ad_name: "Quạt Tổng Hợp 02", effective_status: "ACTIVE", product_group: "fan", slide_key: "FAN_LIGHT_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "972318199015585", campaign_id: "120244295740060424", campaign_name: "Cửa hàng", adset_id: "120244295742440424", adset_name: "Cửa hàng 20km", ad_id: "120244295745820424", ad_name: "Tổng hợp + xả kho", effective_status: "ACTIVE", product_group: "combo", slide_key: "WELCOME_COMBO_SLIDES", drive_folder: "", image_urls: [], notes: "QC tổng hợp: chỉ gửi slide chào mừng combo thiết bị vệ sinh" },
    { ad_account_id: "972318199015585", campaign_id: "120244295740060424", campaign_name: "Cửa hàng", adset_id: "120244295742440424", adset_name: "Cửa hàng 20km", ad_id: "120244297045030424", ad_name: "Tổng hợp- Khuyến mại", effective_status: "ACTIVE", product_group: "combo", slide_key: "WELCOME_COMBO_SLIDES", drive_folder: "", image_urls: [], notes: "QC tổng hợp: chỉ gửi slide chào mừng combo thiết bị vệ sinh" },
    { ad_account_id: "972318199015585", campaign_id: "120244295740060424", campaign_name: "Cửa hàng", adset_id: "120244295742440424", adset_name: "Cửa hàng 20km", ad_id: "120244496819900424", ad_name: "Tủ Chậu - Bản sao", effective_status: "ACTIVE", product_group: "vanity", slide_key: "VANITY_LAVABO_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "972318199015585", campaign_id: "120244298405040424", campaign_name: "Test video mới tbvs cc", adset_id: "120244300148850424", adset_name: "B2C_CC_01", ad_id: "120244497906990424", ad_name: "Lavabo, bệt AI", effective_status: "ACTIVE", product_group: "toilet", slide_key: "SMART_TOILET_SLIDES", drive_folder: "", image_urls: [], notes: "Tên có bệt AI nên ưu tiên bồn cầu thông minh; nếu muốn lavabo thì đổi product_group=vanity" },
    { ad_account_id: "972318199015585", campaign_id: "120244298405040424", campaign_name: "Test video mới tbvs cc", adset_id: "120244621136450424", adset_name: "B2C_CC_02", ad_id: "120244621136470424", ad_name: "Bồn tắm", effective_status: "ACTIVE", product_group: "bathtub", slide_key: "BATHTUB_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "972318199015585", campaign_id: "120244298405040424", campaign_name: "Test video mới tbvs cc", adset_id: "120244621136450424", adset_name: "B2C_CC_02", ad_id: "120244621136460424", ad_name: "Chậu Vòi", effective_status: "ACTIVE", product_group: "faucet", slide_key: "FAUCET_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "773958025271034", campaign_id: "120249960006100494", campaign_name: "Quạt- Test", adset_id: "120249960006090494", adset_name: "Quạt 01", ad_id: "120249960006170494", ad_name: "Quạt 01", effective_status: "ACTIVE", product_group: "fan", slide_key: "FAN_LIGHT_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "311242249583664", campaign_id: "120251754173310195", campaign_name: "quat Guka", adset_id: "120251754173300195", adset_name: "Quạt tổng hợp 1", ad_id: "120251754173290195", ad_name: "Quạt tổng hợp 1", effective_status: "ACTIVE", product_group: "fan", slide_key: "FAN_LIGHT_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "311242249583664", campaign_id: "120251754173310195", campaign_name: "quat Guka", adset_id: "120251755097890195", adset_name: "Quạt tổng hợp 2", ad_id: "120251755097900195", ad_name: "Quạt tổng hợp 2", effective_status: "ACTIVE", product_group: "fan", slide_key: "FAN_LIGHT_SLIDES", drive_folder: "", image_urls: [], notes: "" },
    { ad_account_id: "311242249583664", campaign_id: "120251755254580195", campaign_name: "cửa hàng", adset_id: "120251755854130195", adset_name: "cửa hàng 1", ad_id: "120251755854140195", ad_name: "cửa hàng 1", effective_status: "ACTIVE", product_group: "combo", slide_key: "WELCOME_COMBO_SLIDES", drive_folder: "", image_urls: [], notes: "QC tổng hợp: chỉ gửi slide chào mừng combo thiết bị vệ sinh" },
    { ad_account_id: "311242249583664", campaign_id: "120251755254580195", campaign_name: "cửa hàng", adset_id: "120251755254570195", adset_name: "cửa hàng win", ad_id: "120251755254560195", ad_name: "cửa hàng win", effective_status: "ACTIVE", product_group: "combo", slide_key: "WELCOME_COMBO_SLIDES", drive_folder: "", image_urls: [], notes: "QC tổng hợp: chỉ gửi slide chào mừng combo thiết bị vệ sinh" },
    { ad_account_id: "2908103499363342", campaign_id: "120226451816090207", campaign_name: "VIDEO1 DU HỌC", adset_id: "120226451816080207", adset_name: "111", ad_id: "120226451816070207", ad_name: "2223", effective_status: "ACTIVE", product_group: "unknown", slide_key: "", drive_folder: "", image_urls: [], notes: "Cần xác nhận vì tên không rõ sản phẩm" },
    { ad_account_id: "2908103499363342", campaign_id: "120226451816090207", campaign_name: "VIDEO1 DU HỌC", adset_id: "120226451890260207", adset_name: "111 - Bản sao", ad_id: "120226451890250207", ad_name: "2223", effective_status: "ACTIVE", product_group: "unknown", slide_key: "", drive_folder: "", image_urls: [], notes: "Cần xác nhận vì tên không rõ sản phẩm" },
    { ad_account_id: "2908103499363342", campaign_id: "120236893907130207", campaign_name: "123", adset_id: "120236893907140207", adset_name: "123", ad_id: "120236893907150207", ad_name: "123", effective_status: "ACTIVE", product_group: "unknown", slide_key: "", drive_folder: "", image_urls: [], notes: "Cần xác nhận vì tên không rõ sản phẩm" }
];

function normalizeAdMappingRow(row = {}) {
    const productGroup = normalizeProductAlias(row.product_group || row.productType || row.product || "") || String(row.product_group || row.productType || row.product || "unknown").trim() || "unknown";
    let imageUrls = row.image_urls;
    if (typeof imageUrls === "string") {
        imageUrls = imageUrls.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
    }
    if (!Array.isArray(imageUrls)) imageUrls = [];
    return {
        ad_account_id: String(row.ad_account_id || row.account_id || "").trim(),
        campaign_id: String(row.campaign_id || "").trim(),
        campaign_name: String(row.campaign_name || "").trim(),
        adset_id: String(row.adset_id || row.ad_set_id || "").trim(),
        adset_name: String(row.adset_name || row.ad_set_name || "").trim(),
        ad_id: String(row.ad_id || "").trim(),
        ad_name: String(row.ad_name || "").trim(),
        effective_status: String(row.effective_status || row.status || "").trim(),
        product_group: productGroup,
        product_item_key: String(row.product_item_key || row.item_key || "").trim(),
        slide_key: String(row.slide_key || "").trim(),
        // drive_folder là tên thư mục ảnh trên Google Drive.
        // Admin chỉ cần nhập đúng tên/thư mục Drive, bot tự lấy ảnh từ đó để làm slide.
        drive_folder: String(row.drive_folder || row.drive_folder_name || row.google_drive_folder_name || row.folder || "").trim(),
        // image_urls chỉ giữ làm fallback kỹ thuật, giao diện admin mặc định không bắt nhập link ảnh.
        image_urls: imageUrls,
        notes: String(row.notes || "").trim(),
        is_active: row.is_active === false ? false : true,
        updated_at: new Date().toISOString()
    };
}

function indexAdMappingRows(rows = []) {
    const byKey = {};
    for (const raw of rows) {
        const row = normalizeAdMappingRow(raw);
        if (row.ad_id) byKey[row.ad_id] = row;
        if (row.campaign_id && !byKey[row.campaign_id]) byKey[row.campaign_id] = row;
        if (row.adset_id && !byKey[row.adset_id]) byKey[row.adset_id] = row;
    }
    return byKey;
}

async function loadAdMappingsFromSupabase() {
    if (!supabaseIsReady()) {
        adMappingCache = { byKey: indexAdMappingRows(AD_MAPPING_SEED_ROWS), rows: AD_MAPPING_SEED_ROWS.map(normalizeAdMappingRow), loadedAt: new Date().toISOString(), source: "seed_no_supabase" };
        return adMappingCache;
    }
    try {
        const rows = await supabaseRequest(`${AD_MAPPING_TABLE}?select=*&is_active=eq.true&order=updated_at.desc&limit=5000`, { method: "GET" });
        const finalRows = Array.isArray(rows) && rows.length ? rows.map(normalizeAdMappingRow) : AD_MAPPING_SEED_ROWS.map(normalizeAdMappingRow);
        adMappingCache = { byKey: indexAdMappingRows(finalRows), rows: finalRows, loadedAt: new Date().toISOString(), source: Array.isArray(rows) && rows.length ? "supabase" : "seed_empty_supabase" };
        console.log(`[AD_MAPPING] loaded ${finalRows.length} rows from ${adMappingCache.source}`);
    } catch (error) {
        console.error("[AD_MAPPING] load error:", error.message);
        if (!adMappingCache.rows.length) {
            adMappingCache = { byKey: indexAdMappingRows(AD_MAPPING_SEED_ROWS), rows: AD_MAPPING_SEED_ROWS.map(normalizeAdMappingRow), loadedAt: new Date().toISOString(), source: "seed_after_error" };
        }
    }
    return adMappingCache;
}

function getMappedAdRow(key) {
    if (!key) return null;
    return adMappingCache.byKey[String(key)] || null;
}


function inferAdMappingDefaults(metaRow = {}) {
    const text = [metaRow.ad_name, metaRow.adset_name, metaRow.campaign_name].filter(Boolean).join(" ");
    const product = productFromAdText(text) || "unknown";
    const slideMap = {
        fan: "FAN_LIGHT_SLIDES",
        toilet: "SMART_TOILET_SLIDES",
        vanity: "VANITY_LAVABO_SLIDES",
        kitchen: "KITCHEN_SLIDES",
        faucet: "FAUCET_SLIDES",
        bathtub: "BATHTUB_SLIDES",
        combo: "WELCOME_COMBO_SLIDES"
    };
    return { product_group: product, slide_key: slideMap[product] || "" };
}

function mergeMetaAdRowWithSaved(metaRow = {}, savedRow = {}) {
    const defaults = inferAdMappingDefaults(metaRow);
    const saved = normalizeAdMappingRow(savedRow || {});
    return normalizeAdMappingRow({
        ...metaRow,
        product_group: saved.ad_id ? (saved.product_group || defaults.product_group) : defaults.product_group,
        slide_key: saved.ad_id ? (saved.slide_key || defaults.slide_key) : defaults.slide_key,
        drive_folder: saved.ad_id ? (saved.drive_folder || "") : "",
        image_urls: saved.ad_id ? (saved.image_urls || []) : [],
        notes: saved.ad_id ? (saved.notes || "") : "",
        is_active: saved.ad_id ? saved.is_active !== false : true
    });
}

async function fetchMetaAdsForAdMapping() {
    if (!META_ACCESS_TOKEN) throw new Error("Thiếu META_ACCESS_TOKEN trong Environment");
    const token = encodeURIComponent(META_ACCESS_TOKEN);
    const accounts = await dashboardGetMetaAccounts();
    const activeAccounts = (accounts || []).filter(x => x && (x.id || x.accountId));
    const rows = [];
    const errors = [];

    for (const acc of activeAccounts) {
        const actId = dashboardNormalizeActId(acc.id || acc.accountId || acc.account_id || "");
        if (!actId) continue;
        try {
            const fields = encodeURIComponent([
                "id",
                "name",
                "effective_status",
                "status",
                "created_time",
                "updated_time",
                "campaign{id,name,effective_status,status}",
                "adset{id,name,effective_status,status}"
            ].join(","));
            const url = `https://graph.facebook.com/v23.0/${actId}/ads?fields=${fields}&limit=500&access_token=${token}`;
            const ads = await dashboardFetchGraphPages(url, 20);
            for (const ad of ads || []) {
                rows.push(normalizeAdMappingRow({
                    ad_account_id: actId.replace(/^act_/, ""),
                    campaign_id: ad?.campaign?.id || ad.campaign_id || "",
                    campaign_name: ad?.campaign?.name || "",
                    adset_id: ad?.adset?.id || ad.adset_id || "",
                    adset_name: ad?.adset?.name || "",
                    ad_id: ad.id || "",
                    ad_name: ad.name || "",
                    effective_status: ad.effective_status || ad.status || "",
                    product_group: "unknown",
                    slide_key: "",
                    drive_folder: "",
                    notes: "",
                    is_active: true
                }));
            }
        } catch (error) {
            errors.push({ ad_account_id: actId.replace(/^act_/, ""), account_name: acc.name || "", error: error.message });
        }
    }

    const dedup = new Map();
    for (const row of rows) if (row.ad_id) dedup.set(row.ad_id, row);
    return { rows: Array.from(dedup.values()), accounts: activeAccounts, errors };
}

async function getAdMappingRowsAll() {
    if (!supabaseIsReady()) return [];
    const rows = await supabaseRequest(`${AD_MAPPING_TABLE}?select=*&order=updated_at.desc&limit=10000`, { method: "GET" });
    return Array.isArray(rows) ? rows.map(normalizeAdMappingRow) : [];
}

async function buildMetaAdMappingRows({ sync = false } = {}) {
    const savedRows = await getAdMappingRowsAll().catch(() => []);
    const savedByAdId = new Map(savedRows.filter(x => x.ad_id).map(x => [x.ad_id, x]));
    const meta = await fetchMetaAdsForAdMapping();
    const mergedRows = meta.rows.map(row => mergeMetaAdRowWithSaved(row, savedByAdId.get(row.ad_id)));

    // Nếu Supabase đang có mapping cũ nhưng Meta lần này không trả về, vẫn giữ lại để tránh mất cấu hình.
    const metaIds = new Set(mergedRows.map(x => x.ad_id));
    for (const saved of savedRows) {
        if (saved.ad_id && !metaIds.has(saved.ad_id)) mergedRows.push(saved);
    }

    if (sync && supabaseIsReady() && mergedRows.length) {
        await supabaseRequest(`${AD_MAPPING_TABLE}?on_conflict=ad_id`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(mergedRows)
        });
        await loadAdMappingsFromSupabase();
    }

    return {
        success: true,
        source: sync ? "meta+supabase_synced" : "meta+supabase_preview",
        rows: mergedRows,
        count: mergedRows.length,
        meta_count: meta.rows.length,
        saved_count: savedRows.length,
        errors: meta.errors || []
    };
}

function getAdProductMap() {
    const result = {};
    for (const row of adMappingCache.rows || []) {
        if (!row || row.is_active === false) continue;
        const mapped = normalizeProductAlias(row.product_group) || row.product_group;
        if (!mapped || mapped === "unknown") continue;
        if (row.ad_id) result[row.ad_id] = mapped;
        if (row.campaign_id && !result[row.campaign_id]) result[row.campaign_id] = mapped;
        if (row.adset_id && !result[row.adset_id]) result[row.adset_id] = mapped;
    }
    try {
        const raw = process.env.AD_PRODUCT_MAP || "";
        if (raw.trim()) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(result, parsed);
        }
    } catch (error) {
        console.error("AD_PRODUCT_MAP parse error:", error.message);
    }
    return result;
}

function normalizeProductAlias(value = "") {
    const v = normalizeAdText(value);
    if (["fan", "quat", "quat_tran"].includes(v)) return "fan";
    if (["toilet", "bon_cau", "bon_cau_thong_minh"].includes(v)) return "toilet";
    if (["vanity", "tu_chau", "tu_lavabo", "tu_chau_guong"].includes(v)) return "vanity";
    if (["kitchen", "bep", "bep_hut_mui"].includes(v)) return "kitchen";
    if (["faucet", "sen_voi", "lavabo"].includes(v)) return "faucet";
    if (["bathtub", "bon_tam", "bontam"].includes(v)) return "bathtub";
    if (["combo", "tbvs", "bathroom", "thiet_bi_ve_sinh"].includes(v)) return "combo";
    return null;
}

function detectProductFromReferral(event = {}) {
    const referral = getReferralInfoFromEvent(event);
    const map = getAdProductMap();
    const keys = [referral.ad_id, referral.ref, referral.campaign_id, referral.adgroup_id].filter(Boolean);
    for (const key of keys) {
        const mapped = normalizeProductAlias(map[key]);
        if (mapped) return mapped;
    }
    const joined = [
        referral.ref,
        referral.ad_id,
        referral.campaign_id,
        referral.adgroup_id,
        event?.message?.quick_reply?.payload,
        event?.postback?.payload
    ].filter(Boolean).join(" ");
    return productFromAdText(joined);
}

function getAdSessionKey(event = {}, productType = "") {
    const referral = getReferralInfoFromEvent(event);
    return referral.ad_id || referral.ref || referral.campaign_id || `product:${productType || "unknown"}`;
}

function lockProductForConversation(state, productType, source = "unknown") {
    if (!productType || !state) return;
    if (!state.lockedProduct) {
        state.lockedProduct = productType;
        state.lockedProductSource = source;
    }
    state.currentTopic = state.lockedProduct;
    state.productType = state.lockedProduct;
}

function resolveWorkflowProduct(state, customerMessage = "", historyText = "", event = {}) {
    const fromAd = detectProductFromReferral(event);
    if (fromAd) lockProductForConversation(state, fromAd, "ad_referral");

    const explicit = detectExplicitTopic(customerMessage);
    // Chỉ cho đổi khóa sản phẩm khi khách chủ động nói rõ sản phẩm khác.
    if (explicit && explicit !== state.lockedProduct) {
        if (state.lockedProduct) {
            if (!Array.isArray(state.previousTopics)) state.previousTopics = [];
            state.previousTopics.push({ topic: state.lockedProduct, changedTo: explicit, time: Date.now() });
            state.previousTopics = state.previousTopics.slice(-10);
        }
        state.lockedProduct = explicit;
        state.lockedProductSource = "customer_explicit";
        state.currentTopic = explicit;
        state.productType = explicit;
        return explicit;
    }

    if (state.lockedProduct) return state.lockedProduct;
    const detected = detectProductType(customerMessage, historyText) || state.currentTopic || state.productType;
    if (detected) lockProductForConversation(state, detected, "message_or_history");
    return detected || null;
}

function normalizeMediaProduct(productType) {
    // 4.0.3: không map toilet -> combo nữa, vì sẽ trộn bồn cầu với sen/lavabo/combo phòng tắm.
    // Chỉ dùng ảnh đúng nhóm; nếu chưa có ảnh nhóm đó thì không gửi carousel sai.
    return productType || "combo";
}

function productShowcaseTitle(productType) {
    if (productType === "fan") return "🔥 Mẫu quạt trần bán chạy tháng này";
    if (productType === "kitchen") return "🔥 Mẫu bếp từ - hút mùi bán chạy tháng này";
    if (productType === "vanity") return "🔥 Mẫu tủ chậu gương bán chạy tháng này";
    if (productType === "faucet") return "🔥 Mẫu lavabo - sen vòi bán chạy tháng này";
    if (productType === "toilet") return "🔥 Mẫu bồn cầu thông minh bán chạy tháng này";
    if (productType === "bathtub") return "🔥 Mẫu bồn tắm bán chạy tháng này";
    return "🔥 Mẫu thiết bị vệ sinh bán chạy tháng này";
}

function buildShowcaseElements(items, productType, titlePrefix = "Mẫu") {
    const title0 = productShowcaseTitle(productType);
    return (items || []).slice(0, 10).map((item, idx) => ({
        title: String(idx === 0 ? title0 : (item.title || item.name || `${titlePrefix} ${idx + 1}`)).slice(0, 80),
        subtitle: "Chi tiết và báo giá liên hệ Hotline 0973693677",
        image_url: item.image_url,
        buttons: [{ type: "phone_number", title: "Gọi hotline", payload: "0973693677" }]
    })).filter(x => isProbablyPublicImageUrl(x.image_url));
}

async function findProductRowSafe(productType, message = "", history = "") {
    try {
        return await findBestProductRow(productType, message, history);
    } catch (error) {
        console.error("findProductRowSafe error:", error.message);
        return null;
    }
}

async function collectImagesFromDriveFolder(folder, limit = 10) {
    if (!folder) return [];
    try {
        const items = await listProductImagesByPath(folder);
        return (items || []).slice(0, Math.max(1, limit));
    } catch (error) {
        console.warn("[DRIVE] Cannot load folder", folder, error.message);
        return [];
    }
}

async function buildProductItemElements(item, limit = 10) {
    const images = await collectImagesFromDriveFolder(item?.drive_folder || productItemLabel(item), limit);
    return images.map((img, idx) => ({
        title: String(idx === 0 ? productItemLabel(item) : (img.title || `${productItemLabel(item)} ${idx + 1}`)).slice(0, 80),
        subtitle: "Chi tiết và báo giá liên hệ Hotline 0973693677",
        image_url: img.image_url,
        buttons: [{ type: "phone_number", title: "Gọi hotline", payload: "0973693677" }]
    })).filter(x => x.image_url);
}

async function buildGroupWelcomeElements(productType, maxCards = 10) {
    const candidates = productItemCandidatesForGroup(productType);
    const elements = [];
    for (const item of candidates) {
        const perItem = Math.max(1, Math.min(3, Number(item.images_per_welcome || 3)));
        const images = await collectImagesFromDriveFolder(item.drive_folder, perItem);
        for (let i = 0; i < images.length && elements.length < maxCards; i++) {
            elements.push({
                title: String(i === 0 ? productItemLabel(item) : `${productItemLabel(item)} ${i + 1}`).slice(0, 80),
                subtitle: "Mẫu tiêu biểu trong nhóm, liên hệ 0973693677 để nhận thêm album và báo giá",
                image_url: images[i].image_url,
                buttons: [{ type: "phone_number", title: "Gọi hotline", payload: "0973693677" }]
            });
        }
        if (elements.length >= maxCards) break;
    }
    return elements;
}

async function sendProductChoiceQuestion(senderId, state, reason = "direct_unknown") {
    const text = buildDirectProductChoiceText();
    await sendMessage(senderId, text);
    conversations[senderId] = conversations[senderId] || [];
    conversations[senderId].push(`Bot: ${text} | TIME:${Date.now()} | PRODUCT:unknown | A4_PRODUCT_CHOICE:${reason}`);
    conversations[senderId] = conversations[senderId].slice(-120);
    state.awaitingProductChoice = true;
    state.lastProductChoiceAskAt = Date.now();
    saveConversations(conversations);
    saveCustomerStates(customerStates);
    logMessageToSupabase({ senderId, pageId: state.lastPageId || "", role: "bot", text, messageType: "text", productGroup: "", intent: "ask_product_choice", raw: { reason } }).catch(err => console.error("Supabase product choice log error:", err.message));
}

async function sendWelcomeProductShowcase(senderId, productType, productRow, state, adKey, customerMessage = "") {
    const mediaProduct = normalizeMediaProduct(productType);
    const mappedAd = getMappedAdRow(adKey);
    const explicitItem = detectProductItemFromText(customerMessage, productType) || findProductItemByKey(mappedAd?.product_item_key || state.productItemKey || "");
    let elements = [];
    let items = [];
    let source = "product_media";
    let usedDriveFolder = "";
    let usedProductItemKey = explicitItem?.product_item_key || "";

    if (explicitItem) {
        elements = await buildProductItemElements(explicitItem, 10);
        source = "product_item_drive_folder";
        usedDriveFolder = explicitItem.drive_folder;
    }

    // Nếu QC chỉ khóa nhóm sản phẩm, gửi slide welcome nhóm: mỗi sản phẩm lấy 3 ảnh.
    if (!elements.length && !mappedAd?.drive_folder) {
        elements = await buildGroupWelcomeElements(mediaProduct, 10);
        if (elements.length) source = "product_group_welcome_items";
    }

    // Ưu tiên folder đã map theo đúng quảng cáo nếu người dùng nhập trong Ad Mapping.
    if (!elements.length && mappedAd && mappedAd.drive_folder) {
        items = await collectImagesFromDriveFolder(mappedAd.drive_folder, 10);
        if (items.length) {
            source = "ad_mapping_drive_folder";
            usedDriveFolder = mappedAd.drive_folder;
            elements = buildShowcaseElements(items, productType, mappedAd.ad_name || "Mẫu");
        } else {
            console.warn("[AD_MAPPING] Drive folder has no images", { adKey, drive_folder: mappedAd.drive_folder });
        }
    }

    // Fallback kỹ thuật: vẫn hỗ trợ image_urls cũ nếu có dữ liệu cũ trong Supabase.
    if (!elements.length && mappedAd && Array.isArray(mappedAd.image_urls) && mappedAd.image_urls.length) {
        source = "ad_mapping_image_urls_fallback";
        items = mappedAd.image_urls.map((url, idx) => ({
            title: mappedAd.ad_name || mappedAd.slide_key || `Mẫu ${idx + 1}`,
            name: mappedAd.ad_name || mappedAd.slide_key || `Mẫu ${idx + 1}`,
            image_url: url
        }));
        elements = buildShowcaseElements(items, productType, mappedAd.ad_name || "Mẫu");
    }

    // Fallback cuối: chỉ dùng ảnh đúng nhóm cũ. Không map nhóm khác sang combo.
    if (!elements.length) {
        items = await loadProductMediaItems(mediaProduct, productRow);
        elements = buildShowcaseElements((items || []).slice(0, 10), productType, productRow?.group || "Mẫu");
    }

    if (!elements.length) return { sent: false, reason: "no_scoped_items", productType, product_item_key: usedProductItemKey };

    await sendTemplate(senderId, elements, `AIGUKA4 welcome showcase ${productType}${usedProductItemKey ? ` ${usedProductItemKey}` : ""}`);

    if (!state.welcomeShowcases || typeof state.welcomeShowcases !== "object") state.welcomeShowcases = {};
    state.welcomeShowcases[adKey] = { productType, product_item_key: usedProductItemKey, sentAt: Date.now(), count: elements.length, source, drive_folder: usedDriveFolder || mappedAd?.drive_folder || "" };
    state.productItemKey = usedProductItemKey || state.productItemKey || "";

    if (!state.photoMemory || typeof state.photoMemory !== "object") state.photoMemory = {};
    const key = usedProductItemKey || productPhotoKey(mediaProduct, productRow);
    state.photoMemory[key] = { stage: 1, sentCount: elements.length, total: items.length || elements.length, updatedAt: Date.now(), welcome: true };
    state.sampleSentCount = Number(state.sampleSentCount || 0) + 1;
    state.lastCarouselTime = Date.now();
    logBotEventToSupabase({ senderId, eventType: "carousel_decision", eventData: { product_group: productType, product_item_key: usedProductItemKey, carousel_key: mappedAd?.slide_key || "dynamic_drive", drive_folder: usedDriveFolder || mappedAd?.drive_folder || "", source, elements_count: elements.length } }).catch(() => {});
    return { sent: true, count: elements.length, total: items.length || elements.length, source, product_item_key: usedProductItemKey, drive_folder: usedDriveFolder || mappedAd?.drive_folder || "" };
}

function isPriceFirstObjection(message = "") {
    const msg = normalizeIntentText(message);
    return [
        "bao gia roi gui so", "bao gia roi gui sdt", "bao gia roi gui zalo",
        "bao gia truoc", "cho gia truoc", "biet gia moi", "bao nhieu tien moi mua",
        "bao nhieu tien moi lay", "chuan bi tien", "co gia moi gui so"
    ].some(x => msg.includes(x));
}

function buildSafePriceOrPhoneReply(productType, productRow, customerMessage = "") {
    if (productRow) {
        const range = buildPriceRangeReply(productRow, productType);
        if (range && !normalizeIntentText(range).includes("can kiem tra lai dung mau")) return range;
    }

    if (productType === "fan") {
        return "Dạ mẫu quạt bên em có nhiều phiên bản, giá khoảng 4,39 triệu đến 8,45 triệu tùy động cơ và phân khúc ạ. Nếu anh thấy tầm giá phù hợp, anh để lại SĐT/Zalo để bên em gửi đúng mẫu trong quảng cáo và báo chi tiết nhé.";
    }
    if (productType === "kitchen") {
        return "Dạ nhóm bếp từ - hút mùi bên em có nhiều phân khúc, thường từ khoảng 5 triệu đến hơn 20 triệu tùy bộ ạ. Anh để lại SĐT/Zalo, bên em gửi đúng mẫu phù hợp và báo chi tiết nhé.";
    }
    if (productType === "toilet") {
        return "Dạ bồn cầu thông minh bên em có nhiều phiên bản từ cơ bản đến cao cấp. Giá phụ thuộc tính năng như tự rửa, sấy, tự xả, UV và điều khiển. Anh để lại SĐT/Zalo, bên em gửi đúng mẫu trong quảng cáo và báo chi tiết nhé.";
    }
    if (productType === "vanity") {
        return "Dạ tủ chậu gương/tủ lavabo bên em có nhiều kích thước và chất liệu, giá thay đổi theo bộ. Anh để lại SĐT/Zalo, bên em gửi đúng mẫu, kích thước và báo chi tiết cho mình nhé.";
    }
    return "Dạ nhóm sản phẩm này có nhiều mẫu và phân khúc khác nhau. Anh để lại SĐT/Zalo, bên em gửi đúng mẫu phù hợp và báo giá chi tiết nhé.";
}

function buildWelcomeText(productType, isOldCustomer, inOffice = isOfficeHoursVN()) {
    if (isOldCustomer) {
        const label = productLabel(productType);
        return `Dạ em thấy mình từng nhắn với showroom trước đó rồi ạ. Em gửi lại một số mẫu ${label} bán chạy để mình xem trước nhé.
${buildPostSlideReply(productType, inOffice)}`;
    }
    return buildPostSlideReply(productType, inOffice);
}

function countRecentCustomerTurnsForWorkflow(history = []) {
    if (!Array.isArray(history)) return 0;
    return history.filter(line => String(line || "").startsWith("Khách:")).length;
}

function getRecentBotReplies(history = [], limit = 8) {
    return (Array.isArray(history) ? history : [])
        .filter(line => String(line || "").startsWith("Bot:"))
        .slice(-limit)
        .map(line => extractBotTextFromHistoryLine(line))
        .filter(Boolean);
}

function similarityScore(a = "", b = "") {
    const wa = normalizeIntentText(a).split(/\s+/).filter(w => w.length > 1);
    const wb = normalizeIntentText(b).split(/\s+/).filter(w => w.length > 1);
    if (!wa.length || !wb.length) return 0;
    const setA = new Set(wa);
    const setB = new Set(wb);
    let common = 0;
    for (const w of setA) if (setB.has(w)) common++;
    return common / Math.max(setA.size, setB.size);
}

function containsPhoneAsk(text = "") {
    const msg = normalizeIntentText(text);
    return ["sdt", "so dien thoai", "zalo", "za lo", "hotline"].some(w => msg.includes(w));
}

function leadScoreForMessage(message = "") {
    const msg = normalizeIntentText(message);
    let score = 0;
    if (["gia", "bao gia", "bao nhieu", "bao nhieu tien"].some(w => msg.includes(w))) score += 3;
    if (["mua", "lay", "dat", "con hang", "co hang", "ship", "giao", "lap dat"].some(w => msg.includes(w))) score += 2;
    if (["bao hanh", "dia chi", "showroom", "o dau"].some(w => msg.includes(w))) score += 2;
    if (["chuc nang", "tinh nang", "thong so", "kich thuoc"].some(w => msg.includes(w))) score += 1;
    if (isPriceFirstObjection(message)) score += 4;
    return score;
}

function shouldAskPhoneInReply404({ message = "", state = {}, history = [], justWelcomed = false } = {}) {
    if (state.hasContact || hasPhoneOrContact((history || []).join(" "))) return false;
    if (state.phoneRejected || state.preferMessenger) return false;
    if (justWelcomed) return false; // lời chào đầu đã có lời mời SĐT/Zalo rồi
    const turns = countRecentCustomerTurnsForWorkflow(history);
    const score = leadScoreForMessage(message);
    if (score >= 5) return true;
    if (turns >= 3) return true;
    return false;
}

function buildDirectReplyByIntent(productType, intent, customerMessage = "", state = {}, history = []) {
    if (intent === "ask_address") {
        return "Dạ showroom bên em ở 254 Phố Keo, Gia Lâm, Hà Nội ạ. Hotline showroom: 0973693677. Anh/chị để lại SĐT/Zalo giúp em, sale bên em gửi định vị và tư vấn đúng sản phẩm mình quan tâm nhé.";
    }
    if (intent === "ask_hotline") {
        return "Dạ Hotline showroom bên em là 0973693677 ạ. Anh/chị cũng có thể để lại SĐT/Zalo, sale bên em sẽ chủ động liên hệ và tư vấn đúng mẫu cho mình nhé.";
    }
    if (intent === "ask_open_hours") {
        return buildOpenHoursReply();
    }
    if (intent === "ask_warranty") {
        if (productType === "fan") return "Dạ quạt bên em bảo hành theo từng dòng động cơ và phiên bản ạ. Anh/chị gửi đúng mẫu đang xem hoặc để lại SĐT/Zalo, bên em báo rõ chính sách bảo hành cho mẫu đó nhé.";
        if (productType === "toilet") return "Dạ bồn cầu thông minh bảo hành tùy phiên bản và linh kiện đi kèm ạ. Anh/chị để lại SĐT/Zalo hoặc gửi đúng mẫu đang xem, bên em báo chính xác thời gian bảo hành cho mẫu đó nhé.";
        return "Dạ chính sách bảo hành tùy nhóm sản phẩm và thương hiệu ạ. Anh/chị gửi đúng mẫu đang xem hoặc để lại SĐT/Zalo, bên em báo rõ bảo hành và lắp đặt cho mình nhé.";
    }
    if (intent === "ask_delivery") {
        return "Dạ bên em có hỗ trợ vận chuyển/lắp đặt tùy khu vực và đơn hàng ạ. Anh/chị cho em xin khu vực nhận hàng hoặc SĐT/Zalo, bên em kiểm tra phí và thời gian giao chính xác nhé.";
    }
    if (intent === "general") {
        if (productType === "fan") return "Dạ anh/chị đang xem mẫu quạt nào ạ? Bên em có dòng tiết kiệm và dòng động cơ cao cấp, anh/chị để lại SĐT/Zalo để sale gửi đúng mẫu và báo giá chi tiết nhé.";
        if (productType === "kitchen") return "Dạ nhóm đồ bếp bên em có bếp từ, hút mùi, chậu rửa bát và vòi bếp. Anh/chị nhắn rõ nhóm cần xem hoặc để lại SĐT/Zalo để sale gửi đúng mẫu cho mình nhé.";
        if (productType === "toilet") return buildFeatureReply("toilet");
        if (productType === "vanity") return "Dạ tủ chậu gương/tủ lavabo bên em có nhiều kích thước và kiểu dáng. Anh/chị để lại SĐT/Zalo để sale gửi đúng mẫu phù hợp với phòng tắm nhà mình nhé.";
    }
    return null;
}

function guardReplyBeforeSend(reply = "", { productType = "", message = "", state = {}, history = [], allowPhoneAsk = false } = {}) {
    let text = String(reply || "").trim();
    const norm = normalizeIntentText(text);

    // Chặn câu máy móc từng gây lỗi.
    if (!text || norm.includes("can kiem tra lai dung mau") || norm.includes("tranh bao sai")) {
        text = buildSafePriceOrPhoneReply(productType || state.currentTopic || state.productType || "combo", null, message);
    }

    // Không để slide/nhóm trả lời lẫn sản phẩm rõ ràng.
    if (productType === "kitchen" && ["sen", "lavabo", "bon cau", "phong tam", "nha tam"].some(w => norm.includes(w))) {
        text = "Dạ em hiểu mình đang hỏi đồ bếp ạ. Bên em sẽ chỉ gửi nhóm bếp từ, hút mùi, chậu rửa bát và vòi bếp, không gửi lẫn sen vòi/lavabo phòng tắm. Anh/chị muốn xem bếp từ - hút mùi hay chậu vòi bếp trước ạ?";
    }

    const recent = getRecentBotReplies(history, 6);
    if (recent.some(r => similarityScore(r, text) >= 0.82)) {
        const alt = buildDirectReplyByIntent(productType, detectCustomerIntent(message), message, state, history);
        text = alt && !recent.some(r => similarityScore(r, alt) >= 0.82) ? alt : buildPhoneAskByTopic(productType);
    }

    if (!allowPhoneAsk && containsPhoneAsk(text)) {
        const direct = buildDirectReplyByIntent(productType, detectCustomerIntent(message), message, state, history);
        if (direct) text = direct;
    }

    return text.slice(0, 950);
}

function buildOutsideOfficeContactReply() {
    return "Dạ em đã nhận được thông tin của anh/chị rồi ạ.\nHiện đang ngoài giờ làm việc nên bộ phận tư vấn sẽ liên hệ với anh/chị vào thời gian sớm nhất.\nCảm ơn anh/chị đã quan tâm Showroom Ánh Dương ❤️";
}

function isFirstBotReplyInThisAd(state, adKey) {
    if (!state.welcomeShowcases || typeof state.welcomeShowcases !== "object") return true;
    return !state.welcomeShowcases[adKey];
}

function isMeaningfulOldConversation(history = []) {
    return Array.isArray(history) && history.some(line => String(line).startsWith("Khách:")) && history.length > 1;
}


function parseHistoryTime(line = "") {
    const match = String(line || "").match(/\| TIME:(\d+)/);
    return match ? Number(match[1]) : 0;
}

function getLastCustomerTimeFromHistory(history = []) {
    for (let i = (history || []).length - 1; i >= 0; i--) {
        const line = String(history[i] || "");
        if (line.startsWith("Khách:")) return parseHistoryTime(line);
    }
    return 0;
}

function hasAdminReplyAfterLastCustomer(history = [], windowMs = null) {
    if (!Array.isArray(history) || !history.length) return false;
    const lastCustomerTime = getLastCustomerTimeFromHistory(history);
    if (!lastCustomerTime) return false;

    // AIGUKA 4.2.5: Sale/Admin đã trả lời sau tin khách thì AI mất quyền hội thoại.
    // Không giới hạn 5/10 phút nữa, vì bot không được chen ngang sale.
    // windowMs chỉ dùng khi chủ động muốn kiểm tra trong một cửa sổ thời gian cụ thể.
    for (const line of history) {
        const raw = String(line || "");
        if (!raw.startsWith("Admin:")) continue;
        const t = parseHistoryTime(raw);
        if (!t || t < lastCustomerTime) continue;
        if (windowMs == null) return true;
        if (Date.now() - t <= Math.max(Number(windowMs || 0), 60 * 1000)) return true;
    }
    return false;
}

async function hasSupabaseAdminAfterLastCustomer(senderId, lastCustomerTimeMs = 0) {
    if (!supabaseIsReady() || !senderId || !lastCustomerTimeMs) return false;
    try {
        const since = new Date(Number(lastCustomerTimeMs)).toISOString();
        const rows = await supabaseRequest(
            `messages?sender_id=eq.${encodeURIComponent(String(senderId))}&role=in.(admin,page,sale)&created_at=gte.${encodeURIComponent(since)}&select=id,created_at,text,role&order=created_at.desc&limit=1`,
            { method: "GET" }
        );
        return Array.isArray(rows) && Boolean(rows[0]);
    } catch (error) {
        console.error("hasSupabaseAdminAfterLastCustomer error:", senderId, error.message);
        return false;
    }
}

function cancelBotReplyBecauseSaleAnswered(senderId, reason = "sale_answered") {
    clearCustomerReplyTimer(senderId);
    markPendingRepliesForSender(senderId, "cancelled", reason).catch(err => console.error("Cancel pending sale answered error:", err.message));
    const state = ensureCustomerState(senderId);
    state.owner = "sale";
    state.manualMode = true;
    state.lastManualModeAt = Date.now();
    saveCustomerStates(customerStates);
}

async function processAiguka4Workflow(senderId, event = {}) {
    const state = ensureCustomerState(senderId);
    const history = conversations[senderId] || [];
    const lastCustomerLine = [...history].reverse().find(line => String(line).startsWith("Khách:"));
    if (!lastCustomerLine) return;

    const customerMessage = String(lastCustomerLine).replace(/^Khách:\s*/i, "").split(" | TIME:")[0].trim();
    const historyText = history.slice(-40).join(" ");
    const now = Date.now();
    const currentIntent = detectCustomerIntent(customerMessage);
    state.lastIntent = currentIntent;

    const instantSample = isInstantSampleIntent(customerMessage);
    // 4.2.4 HOTFIX: nhân viên đã trả lời thì bot tuyệt đối không chen ngang,
    // kể cả khách xin mẫu/ảnh. Bot chỉ nhảy vào khi khách nhắn và quá thời gian chờ mà không có sale trả lời.
    if (state.humanTakeoverUntil && now < Number(state.humanTakeoverUntil)) {
        console.log("AIGUKA4 skipped, admin takeover active:", senderId);
        return;
    }
    if (hasAdminReplyAfterLastCustomer(history) || await hasSupabaseAdminAfterLastCustomer(senderId, getLastCustomerTimeFromHistory(history))) {
        console.log("AIGUKA4 skipped, sale/admin replied after latest customer:", senderId);
        cancelBotReplyBecauseSaleAnswered(senderId, "sale_answered_before_workflow");
        return;
    }
    if (state.hasContact || hasPhoneOrContact(historyText)) {
        state.hasContact = true;
        saveCustomerStates(customerStates);
        console.log("AIGUKA4 skipped, customer already has contact:", senderId);
        return;
    }

    // AIGUKA 4.2.8: câu hỏi dịch vụ trả lời trực tiếp, không gửi slide/carousel.
    if (isNoSlideServiceIntent(currentIntent)) {
        const direct = buildDirectReplyByIntent(state.currentTopic || state.productType || state.lockedProduct || "", currentIntent, customerMessage, state, history) || buildUnknownProductClarifyReply();
        await sendMessage(senderId, direct);
        conversations[senderId].push(`Bot: ${direct} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || state.productType || "unknown"} | A4_DIRECT_NO_SLIDE:${currentIntent}`);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        logMessageToSupabase({ senderId, pageId: state.lastPageId || "", role: "bot", text: direct, messageType: "text", productGroup: toDbProductGroup(state.currentTopic || state.productType || "") || "", intent: currentIntent, raw: { no_slide_reason: "service_intent" } }).catch(err => console.error("Supabase direct no-slide log error:", err.message));
        return;
    }

    let productType = resolveWorkflowProduct(state, customerMessage, historyText, event) || groupFromNumericChoice(customerMessage) || null;
    const explicitItem = detectProductItemFromText(customerMessage, productType || state.currentTopic || state.productType || "");
    if (explicitItem) {
        productType = explicitItem.product_group;
        state.productItemKey = explicitItem.product_item_key;
        state.currentTopic = productType;
        state.productType = productType;
    }
    if (shouldAskProductChoice(event, state, productType, customerMessage)) {
        await sendProductChoiceQuestion(senderId, state, "direct_page_no_product");
        return;
    }
    productType = productType || state.currentTopic || state.productType || null;
    if (!productType) {
        const ask = buildUnknownProductClarifyReply();
        await sendMessage(senderId, ask);
        conversations[senderId].push(`Bot: ${ask} | TIME:${Date.now()} | PRODUCT:unknown | A4_SHORT_PRODUCT_CLARIFY_NO_SLIDE`);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        logMessageToSupabase({ senderId, pageId: state.lastPageId || "", role: "bot", text: ask, messageType: "text", productGroup: "", intent: currentIntent, raw: { no_slide_reason: "unknown_product" } }).catch(err => console.error("Supabase unknown product no-slide log error:", err.message));
        return;
    }
    updateSupabaseConversationMetadata(senderId, {
        product_group: toDbProductGroup(productType),
        current_intent: currentIntent,
        page_id: state.lastPageId || null,
        last_message_at: new Date().toISOString()
    }).catch(err => console.error("Workflow conversation update error:", err.message));
    updateSupabaseCustomerState(senderId, state, { last_intent: currentIntent }).catch(err => console.error("Workflow state update error:", err.message));
    const adKey = getAdSessionKey(event, productType);
    const productRow = await findProductRowSafe(productType, customerMessage, historyText);
    const oldCustomer = isMeaningfulOldConversation(history.slice(0, -1));

    // 4.0.5: nếu khách phàn nàn bot gửi sai nhóm, xin lỗi và khóa lại đúng sản phẩm ngay.
    if (detectWrongProductComplaint(customerMessage)) {
        const corrected = detectExplicitTopic(customerMessage) || productType;
        if (corrected) {
            state.lockedProduct = corrected;
            state.currentTopic = corrected;
            state.productType = corrected;
            state.lockedProductSource = "wrong_product_recovery";
        }
        const apology = buildWrongProductRecoveryReply(corrected || productType);
        await sendMessage(senderId, apology);
        conversations[senderId].push(`Bot: ${apology} | TIME:${Date.now()} | PRODUCT:${corrected || productType} | A4_WRONG_PRODUCT_RECOVERY`);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        logMessageToSupabase({ senderId, pageId: state.lastPageId || "", role: "bot", text: apology, messageType: "text", productGroup: toDbProductGroup(corrected || productType), intent: "wrong_product_recovery", raw: { trigger: customerMessage } }).catch(err => console.error("Supabase wrong product recovery log error:", err.message));
        return;
    }

    // 1) Slide mở đầu: luôn là carousel, gửi trước tin nhắn đầu tiên của bot trong phiên quảng cáo.
    let justWelcomed = false;
    if (isFirstBotReplyInThisAd(state, adKey)) {
        const showcase = await sendWelcomeProductShowcase(senderId, productType, productRow, state, adKey, customerMessage);
        aiTrace(senderId, "A4-WELCOME-SHOWCASE", { productType, adKey, ...showcase });
        const welcome = buildWelcomeText(productType, oldCustomer);
        await sendMessage(senderId, welcome);
        conversations[senderId].push(`Bot: ${welcome} | TIME:${Date.now()} | PRODUCT:${productType} | A4_WELCOME`);
        justWelcomed = true;
    }

    // 2) Khách xin xem thêm/xin mẫu/xin ảnh: gửi slide ngay, không chờ admin.
    // Nếu đã gửi slide cho đúng tin khách này rồi, lần xử lý tiếp theo chỉ nhắc nhẹ để lại SĐT/Zalo, không gửi lặp.
    if (instantSample) {
        // Chỉ gửi slide 1 lần trong phiên/nhóm hiện tại. Nếu đã có welcome slide hoặc carousel gần đây,
        // không gửi lại carousel để tránh spam và trùng ảnh.
        if (Number(state.lastInstantSampleCustomerTime || 0) === Number(state.lastCustomerTime || 0) || hasRecentCarousel(state) || (state.welcomeShowcases && state.welcomeShowcases[adKey])) {
            const follow = `Dạ em đã gửi các mẫu ${productLabel(productType)} bán chạy ở trên rồi ạ. Nếu anh/chị cần thông tin chi tiết sản phẩm khác, catalogue đầy đủ hoặc báo giá đúng mẫu, anh/chị để lại SĐT/Zalo để showroom gửi nhanh hơn nhé.`;
            await sendMessage(senderId, follow);
            conversations[senderId].push(`Bot: ${follow} | TIME:${Date.now()} | PRODUCT:${productType} | A4_INSTANT_SAMPLE_ALREADY_SENT`);
            saveConversations(conversations);
            saveCustomerStates(customerStates);
            return;
        }
        const mediaResult = await sendCarouselByProduct(senderId, normalizeMediaProduct(productType), productRow, state, customerMessage);
        aiTrace(senderId, "A4-MORE-SLIDE", mediaResult || {});
        if (mediaResult && mediaResult.sent && mediaResult.needClose) {
            const close = buildAfterSlide2Close(productType, isOfficeHoursVN());
            await sendMessage(senderId, close);
            conversations[senderId].push(`Bot: ${close} | TIME:${Date.now()} | PRODUCT:${productType} | A4_MORE_CLOSE`);
        } else if (!mediaResult || !mediaResult.sent) {
            const close = "Dạ hiện em chưa có đủ ảnh đúng nhóm sản phẩm này để gửi tự động, em không gửi lẫn sang nhóm khác để tránh sai mẫu. Anh/chị để lại SĐT/Zalo, bên em gửi đúng album và báo giá chi tiết cho mình nhé.";
            await sendMessage(senderId, close);
            conversations[senderId].push(`Bot: ${close} | TIME:${Date.now()} | PRODUCT:${productType} | A4_MORE_NO_SCOPED_IMAGE`);
        }
        state.lastInstantSampleCustomerTime = Number(state.lastCustomerTime || Date.now());
        state.lastInstantSampleAt = Date.now();
        if (state.humanTakeoverUntil && now < Number(state.humanTakeoverUntil)) {
            // Admin đang ở đó: bot chỉ hỗ trợ gửi slide rồi dừng, trả quyền cho admin.
            saveConversations(conversations);
            saveCustomerStates(customerStates);
            return;
        }
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return;
    }

    // 3) Hỏi giá / phản đối "báo giá rồi gửi số": báo khoảng giá an toàn, không quay lại câu máy móc.
    if (isPriceRequest(customerMessage) || isPriceFirstObjection(customerMessage)) {
        let reply = buildSafePriceOrPhoneReply(productType, productRow, customerMessage);
        reply = guardReplyBeforeSend(reply, { productType, message: customerMessage, state, history, allowPhoneAsk: true });
        await sendMessage(senderId, reply);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${productType} | A4_PRICE`);
        state.stage = "GET_PHONE";
        state.askedPhone = true;
        state.lastPhoneAskTime = Date.now();
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return;
    }

    // 4) Các câu hỏi đơn giản xử lý bằng rule, hạn chế gọi GPT.
    if (currentIntent === "ask_features") {
        let reply = buildFeatureReply(productType);
        reply = guardReplyBeforeSend(reply, { productType, message: customerMessage, state, history, allowPhoneAsk: shouldAskPhoneInReply404({ message: customerMessage, state, history, justWelcomed }) });
        await sendMessage(senderId, reply);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${productType} | A4_FEATURES`);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return;
    }

    if (isBrandQuestion(customerMessage)) {
        let reply = buildBrandReply(productType);
        reply = guardReplyBeforeSend(reply, { productType, message: customerMessage, state, history, allowPhoneAsk: shouldAskPhoneInReply404({ message: customerMessage, state, history, justWelcomed }) });
        await sendMessage(senderId, reply);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${productType} | A4_BRAND`);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return;
    }

    if (isDontCallMessage(customerMessage)) {
        state.preferMessenger = true;
        state.phoneRejected = true;
        let reply = buildDontCallReply(productType);
        reply = guardReplyBeforeSend(reply, { productType, message: customerMessage, state, history, allowPhoneAsk: false });
        await sendMessage(senderId, reply);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${productType} | A4_DONT_CALL`);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return;
    }

    const allowPhoneAsk = shouldAskPhoneInReply404({ message: customerMessage, state, history, justWelcomed });
    let fallback = buildDirectReplyByIntent(productType, currentIntent, customerMessage, state, history) || buildPhoneAskByTopic(productType);
    if (allowPhoneAsk && !containsPhoneAsk(fallback)) {
        fallback = `${fallback}

${buildPhoneAskByTopic(productType)}`;
    }
    fallback = guardReplyBeforeSend(fallback, { productType, message: customerMessage, state, history, allowPhoneAsk });
    if (containsPhoneAsk(fallback)) {
        state.askedPhone = true;
        state.lastPhoneAskTime = Date.now();
    }
    await sendMessage(senderId, fallback);
    conversations[senderId].push(`Bot: ${fallback} | TIME:${Date.now()} | PRODUCT:${productType} | A4_REPLY_GUARD`);
    saveConversations(conversations);
    saveCustomerStates(customerStates);
}

function registerAndScheduleAiguka4CustomerMessage(senderId, event, customerMessage, now) {
    const state = ensureCustomerState(senderId);
    const historyBefore = conversations[senderId] || [];
    const historyTextBefore = historyBefore.slice(-40).join(" ");

    state.lastPageId = event?.recipient?.id || state.lastPageId || "";
    let productType = resolveWorkflowProduct(state, customerMessage, historyTextBefore, event) || groupFromNumericChoice(customerMessage);
    const explicitItemForRegister = detectProductItemFromText(customerMessage, productType || state.currentTopic || state.productType || "");
    if (explicitItemForRegister) {
        productType = explicitItemForRegister.product_group;
        state.productItemKey = explicitItemForRegister.product_item_key;
    }
    const currentIntent = detectCustomerIntent(customerMessage);
    state.lastIntent = currentIntent;
    if (productType) lockProductForConversation(state, productType, detectProductFromReferral(event) ? "ad_referral" : "message_or_history");
    updateSupabaseConversationMetadata(senderId, {
        page_id: state.lastPageId || null,
        product_group: toDbProductGroup(productType || state.currentTopic || state.productType || ""),
        current_intent: currentIntent,
        last_message_at: new Date(now).toISOString()
    }).catch(err => console.error("Conversation metadata update error:", err.message));
    updateSupabaseCustomerState(senderId, state, { last_intent: currentIntent }).catch(err => console.error("Customer state update error:", err.message));

    if (isDontCallMessage(customerMessage)) {
        state.preferMessenger = true;
        state.phoneRejected = true;
    }

    state.lastCustomerTime = now;
    const humanActiveAtCustomerMessage = Boolean(state.humanTakeoverUntil && now < Number(state.humanTakeoverUntil));
    conversations[senderId].push(`Khách: ${customerMessage} | TIME:${now} | PRODUCT:${state.currentTopic || "unknown"}${humanActiveAtCustomerMessage ? " | HUMAN_TAKEOVER_ACTIVE" : ""}`);
    conversations[senderId] = conversations[senderId].slice(-120);

    if (hasPhoneOrContact(customerMessage)) {
        state.hasContact = true;
        state.stage = "HUMAN_HANDOVER";
        clearCustomerReplyTimer(senderId);
        markPendingRepliesForSender(senderId, "cancelled", "customer_has_contact").catch(err => console.error("Cancel pending contact error:", err.message));
        saveConversations(conversations);
        saveCustomerStates(customerStates);

        if (!isOfficeHoursVN(now) && !state.outsideOfficeContactAckSent && !(state.humanTakeoverUntil && now < Number(state.humanTakeoverUntil))) {
            state.outsideOfficeContactAckSent = true;
            const ack = buildOutsideOfficeContactReply();
            sendMessage(senderId, ack)
                .then(() => {
                    conversations[senderId].push(`Bot: ${ack} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || "unknown"} | A4_OUTSIDE_CONTACT_ACK`);
                    conversations[senderId] = conversations[senderId].slice(-120);
                    saveConversations(conversations);
                    saveCustomerStates(customerStates);
                })
                .catch(err => console.error("Outside office contact ack error:", err.message));
        }
        return;
    }

    saveConversations(conversations);
    saveCustomerStates(customerStates);

    // KHÓA CỨNG: nếu sale/admin đang xử lý, bot chỉ lưu tin khách và tuyệt đối không đặt lịch trả lời.
    // Bot chỉ được quay lại khi có tin khách mới sau thời gian pause, không tự chen sau 10 phút.
    if (humanActiveAtCustomerMessage || (state.humanTakeoverUntil && now < Number(state.humanTakeoverUntil))) {
        console.log("Customer message stored while admin takeover active; no bot timer scheduled:", senderId);
        state.pendingHumanCustomer = true;
        clearCustomerReplyTimer(senderId);
        markPendingRepliesForSender(senderId, "cancelled", "customer_during_admin_takeover").catch(err => console.error("Cancel pending during takeover error:", err.message));
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return;
    }

    clearCustomerReplyTimer(senderId);
    const delay = getBotDelayMs(now);
    const dueAt = now + delay;
    state.pendingBotReplyDueAt = dueAt;
    saveCustomerStates(customerStates);

    scheduleDurablePendingReply({
        senderId,
        pageId: event?.recipient?.id || "",
        dueAtMs: dueAt,
        reason: isOfficeHoursVN(now) ? `office_delay_${Number(currentWorkingSettings().admin_pause_minutes || 10)}m` : `outside_delay_${Number(currentWorkingSettings().outside_wait_minutes || currentWorkingSettings().customer_wait_minutes || 5)}m`
    }).then(result => {
        if (result?.ok) console.log("Durable pending reply", result.action, senderId, result.due_at);
    }).catch(err => console.error("Durable pending schedule promise error:", err.message));

    const timer = setTimeout(async () => {
        customerReplyTimers.delete(senderId);
        try {
            const latestState = ensureCustomerState(senderId);
            if (latestState.hasContact) return;
            if (latestState.humanTakeoverUntil && Date.now() < Number(latestState.humanTakeoverUntil)) return;
            const timerHistory = conversations[senderId] || [];
            if (hasAdminReplyAfterLastCustomer(timerHistory) || await hasSupabaseAdminAfterLastCustomer(senderId, getLastCustomerTimeFromHistory(timerHistory))) {
                console.log("Scheduled bot reply skipped because sale answered:", senderId);
                cancelBotReplyBecauseSaleAnswered(senderId, "sale_answered_before_timer_due");
                markPendingRepliesForSender(senderId, "cancelled", "admin_replied_before_due").catch(err => console.error("Mark pending admin replied error:", err.message));
                return;
            }
            await processAiguka4Workflow(senderId, event);
            markPendingRepliesForSender(senderId, "sent", "sent_by_memory_timer").catch(err => console.error("Mark pending sent error:", err.message));
        } catch (error) {
            console.error("AIGUKA4 scheduled workflow error:", senderId, error);
        }
    }, delay);

    customerReplyTimers.set(senderId, timer);
    console.log(`AIGUKA4 scheduled reply for ${senderId} in ${Math.round(delay / 60000)} minutes`);
}

function clearHumanTakeoverTimer(senderId) {
    const timer = humanTakeoverTimers.get(senderId);
    if (timer) {
        clearTimeout(timer);
        humanTakeoverTimers.delete(senderId);
    }
}

function scheduleBotResumeAfterHumanTakeover(senderId) {
    clearHumanTakeoverTimer(senderId);

    const state = ensureCustomerState(senderId);
    const now = Date.now();
    const resumeAt = Number(state.humanTakeoverUntil || 0);
    const delay = Math.max(resumeAt - now + 1000, 1000);

    const timer = setTimeout(async () => {
        humanTakeoverTimers.delete(senderId);

        try {
            const latestState = ensureCustomerState(senderId);
            const currentTime = Date.now();

            // Nếu admin vừa trả lời tiếp thì thời gian pause đã được kéo dài, không xử lý.
            if (latestState.humanTakeoverUntil && currentTime < Number(latestState.humanTakeoverUntil)) {
                scheduleBotResumeAfterHumanTakeover(senderId);
                return;
            }

            const history = conversations[senderId];
            if (!Array.isArray(history) || history.length === 0) return;

            // Chỉ trả lời nếu tin cuối cùng là của khách trong lúc admin takeover.
            const lastLine = String(history[history.length - 1] || "");
            if (!lastLine.startsWith("Khách:") || !lastLine.includes("HUMAN_TAKEOVER_ACTIVE")) {
                console.log("Resume skipped, last message is not pending customer:", senderId);
                return;
            }

            // Nếu khách đã để lại số, không để bot chen thêm.
            const historyText = history.join(" ");
            if (latestState.hasContact || hasPhoneOrContact(historyText)) {
                latestState.hasContact = true;
                saveCustomerStates(customerStates);
                console.log("Resume skipped, customer already has contact:", senderId);
                return;
            }

            console.log("Human takeover expired, bot resumes after reading history:", senderId);

            const currentHistoryText = history.slice(-30).join(" ");
            if (!latestState.currentTopic) {
                const detectedFromHistory = detectProductType("", currentHistoryText);
                if (detectedFromHistory) {
                    latestState.currentTopic = detectedFromHistory;
                    latestState.productType = detectedFromHistory;
                }
            }

            const aiHistory = history.slice(-30).join("\n");
            const aiReply = await getAIReply(aiHistory);

            latestState.humanTakeoverUntil = null;
            latestState.stage = latestState.stage || "DISCOVERY";

            conversations[senderId].push(`Bot sau admin 10p: ${aiReply} | TIME:${Date.now()} | PRODUCT:${latestState.currentTopic || "unknown"}`);
            conversations[senderId] = conversations[senderId].slice(-80);

            saveConversations(conversations);
            saveCustomerStates(customerStates);

            await sendMessage(senderId, aiReply);
        } catch (error) {
            console.error("Resume after human takeover error:", senderId, error);
        }
    }, delay);

    humanTakeoverTimers.set(senderId, timer);
}


function isSpecificConsultRequest(customerMessage, state) {
    const msg = String(customerMessage || "").toLowerCase();

    const explicitTopic = detectExplicitTopic(msg);
    if (!explicitTopic) return false;

    const consultWords = [
        "tư vấn", "tu van", "cần tư vấn", "can tu van",
        "hỏi", "hoi", "xem", "xin", "gửi", "gui",
        "giá", "gia", "báo giá", "bao gia",
        "có loại", "co loai", "loại nào", "loai nao",
        "mẫu", "mau", "ảnh", "hình", "catalog"
    ];

    if (consultWords.some(word => msg.includes(word))) return true;

    // Nếu khách chỉ nhắn tên sản phẩm cụ thể như "quạt", "lavabo", "sen vòi"
    // vẫn coi là cần tư vấn ban đầu.
    if (msg.trim().length <= 40) return true;

    return false;
}

function buildNeedQuestion(productType) {
    if (productType === "fan") {
        return "Dạ anh đang cần xem quạt cho phòng khoảng bao nhiêu m2 và thích kiểu hiện đại, mạ vàng hay quạt đèn ạ?";
    }

    if (productType === "toilet") {
        return "Dạ anh/chị đang cần bồn cầu thông minh cho nhà mới hay thay bồn cũ ạ? Anh/chị muốn dòng cơ bản dễ dùng hay dòng nhiều tính năng như tự rửa, sấy, UV, điều khiển giọng nói?";
    }

    if (productType === "vanity") {
        return "Dạ anh/chị đang cần tủ chậu gương/tủ lavabo cho nhà mới hay thay bộ cũ ạ? Phòng tắm nhà mình cần mẫu treo tường gọn gàng hay mẫu tủ chậu đẹp đồng bộ hơn chút?";
    }

    if (productType === "combo") {
        return "Dạ anh đang cần thiết bị vệ sinh cho nhà mới hay thay đồ cũ ạ? Anh muốn xem combo tầm giá cơ bản, trung cấp hay đẹp hơn chút?";
    }

    if (productType === "faucet") {
        return "Dạ anh đang cần sen vòi, lavabo hay chậu rửa ạ? Anh muốn mẫu cơ bản dễ dùng hay mẫu đẹp đồng bộ hơn chút?";
    }

    if (productType === "kitchen") {
        return "Dạ anh đang cần tủ, chậu rửa, vòi bếp hay thiết bị bếp ạ? Anh muốn xem mẫu theo ngân sách khoảng bao nhiêu?";
    }

    if (productType === "kitchen_bath") {
        return "Dạ anh đang cần tư vấn khu bếp hay phòng tắm trước ạ? Anh muốn xem mẫu theo ngân sách cơ bản hay đẹp hơn một chút?";
    }

    return "Dạ anh đang cần tư vấn nhóm sản phẩm nào và ngân sách khoảng bao nhiêu để em lọc mẫu phù hợp ạ?";
}

function buildPhoneAskAfterNeed(productType) {
    if (productType === "fan") {
        return "Dạ với nhu cầu này bên em cần gửi nhiều mẫu thực tế và báo giá theo từng phiên bản. Anh để lại SĐT/Zalo, bên em gửi mẫu quạt phù hợp và tư vấn nhanh cho anh nhé?";
    }

    if (productType === "toilet") {
        return "Dạ bên em có nhiều mẫu bồn cầu thông minh và bồn cầu AI, mỗi mẫu khác nhau về tính năng và tầm giá. Anh/chị để lại SĐT/Zalo, bên em gửi đúng mẫu kèm khoảng giá và tư vấn nhanh cho mình nhé?";
    }

    if (productType === "vanity") {
        return "Dạ tủ chậu gương/tủ lavabo có nhiều kích thước và kiểu phối khác nhau, gửi qua Zalo sẽ rõ mẫu và dễ chọn hơn. Anh/chị để lại SĐT/Zalo, bên em gửi mẫu phù hợp kèm khoảng giá cho mình nhé?";
    }

    if (productType === "combo" || productType === "faucet" || productType === "kitchen" || productType === "kitchen_bath") {
        return "Dạ bên em có nhiều mẫu và mức giá khác nhau, gửi qua Zalo sẽ rõ và dễ chọn hơn. Anh để lại SĐT/Zalo, bên em gửi mẫu phù hợp và báo giá chi tiết cho anh nhé?";
    }

    return "Dạ anh để lại SĐT/Zalo, bên em gửi mẫu phù hợp và báo giá chi tiết cho anh nhé?";
}

function isMeaningfulNeedAnswer(customerMessage) {
    const msg = String(customerMessage || "").toLowerCase().trim();

    if (!msg) return false;
    if (hasPhoneOrContact(msg)) return false;
    if (shouldSendCarousel(msg)) return false;
    if (isDontCallMessage(msg)) return false;

    // Các câu trả lời nhu cầu thường có diện tích, ngân sách, phân khúc, kiểu dáng, phòng, màu, loại...
    const needWords = [
        "m2", "mét", "met", "phòng", "phong", "khách", "khach", "ngủ", "ngu",
        "triệu", "trieu", "khoảng", "khoang", "tầm", "tam",
        "rẻ", "re", "cao cấp", "cao cap", "trung cấp", "trung cap", "cơ bản", "co ban",
        "hiện đại", "hien dai", "mạ vàng", "ma vang", "đèn", "den",
        "lavabo", "sen", "vòi", "voi", "bồn", "bon", "combo", "tủ", "tu", "tủ chậu", "tu chau", "tủ lavabo", "tu lavabo", "gương", "guong", "chậu", "chau",
        "nhà mới", "nha moi", "thay", "đổi", "doi", "cần", "can"
    ];

    if (needWords.some(word => msg.includes(word))) return true;

    // Câu ngắn như "loại rẻ", "cơ bản", "8tr", "30m2" vẫn là câu trả lời nhu cầu.
    if (/(\d+\s*(m2|m|tr|triệu|trieu|k))/.test(msg)) return true;
    if (msg.length <= 80) return true;

    return false;
}


function normalizeEchoText(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function getEchoTextFromEvent(event) {
    if (!event || !event.message) return "";

    if (event.message.text && String(event.message.text).trim()) {
        return String(event.message.text).trim();
    }

    if (Array.isArray(event.message.attachments) && event.message.attachments.length > 0) {
        const types = event.message.attachments.map(a => a.type).join(", ");
        return `[attachment:${types || "unknown"}]`;
    }

    return "";
}

function extractBotTextFromHistoryLine(line) {
    const raw = String(line || "");
    const botIndex = raw.indexOf("Bot");
    if (botIndex === -1) return "";

    const colonIndex = raw.indexOf(":", botIndex);
    if (colonIndex === -1) return "";

    const timeIndex = raw.indexOf("| TIME:", colonIndex);
    const text = timeIndex === -1 ? raw.slice(colonIndex + 1) : raw.slice(colonIndex + 1, timeIndex);

    return text.trim();
}

function isOwnBotEcho(senderId, event) {
    const echoText = getEchoTextFromEvent(event);
    const normalizedEcho = normalizeEchoText(echoText);

    // Bot gửi ảnh/template thường có app_id và không có text rõ.
    if (event.message && event.message.app_id && !normalizedEcho) {
        return true;
    }

    // Nếu không có text, coi là echo hệ thống/bot, không kích hoạt admin takeover.
    if (!normalizedEcho) {
        return true;
    }

    const history = conversations[senderId] || [];
    const recentLines = history.slice(-20);

    for (const line of recentLines) {
        const botText = normalizeEchoText(extractBotTextFromHistoryLine(line));
        if (!botText) continue;

        if (botText === normalizedEcho) return true;

        // Một số echo có thể bị cắt hoặc thay đổi khoảng trắng nhẹ.
        if (botText.length > 20 && normalizedEcho.length > 20) {
            if (botText.includes(normalizedEcho) || normalizedEcho.includes(botText)) {
                return true;
            }
        }
    }

    // 4.2.4 HOTFIX: nếu echo có text nhưng không trùng tin bot gần nhất,
    // coi đó là nhân viên/page trả lời thủ công, kể cả khi nền tảng gắn app_id.
    // Lỗi cũ: cứ có app_id là bỏ qua => bot không pause và chen ngang sale.
    return false;
}

function startHumanTakeover(senderId, adminText, now) {
    const state = ensureCustomerState(senderId);

    const pauseMs = Number(currentWorkingSettings().admin_pause_minutes || 10) * 60 * 1000;
    // Sale/admin nhắn tiếp thì gia hạn lại từ thời điểm mới nhất.
    state.humanTakeoverUntil = Math.max(Number(state.humanTakeoverUntil || 0), now + pauseMs);
    state.pendingHumanCustomer = false;
    state.lastAdminTime = now;
    state.owner = "sale";
    state.manualMode = true;
    state.lastManualModeAt = now;

    clearHumanTakeoverTimer(senderId);
    clearCustomerReplyTimer(senderId);
    markPendingRepliesForSender(senderId, "admin_taken", "admin_echo_detected").catch(err => console.error("Admin pending cancel error:", err.message));
    updateSupabaseCustomerState(senderId, state, { admin_takeover: true, bot_paused_until: new Date(Number(state.humanTakeoverUntil)).toISOString() })
        .catch(err => console.error("Supabase admin pause state error:", err.message));

    conversations[senderId].push(`Admin: ${adminText || "[admin attachment/action]"} | TIME:${now} | PRODUCT:${state.currentTopic || "unknown"}`);
    conversations[senderId] = conversations[senderId].slice(-80);

    saveConversations(conversations);
    saveCustomerStates(customerStates);
    logMessageToSupabase({
        senderId,
        pageId: state.lastPageId || "",
        role: "admin",
        text: adminText || "[admin attachment/action]",
        messageType: String(adminText || "").startsWith("[attachment:") ? "attachment" : "text",
        productGroup: toDbProductGroup(state.currentTopic || state.productType || state.lockedProduct || ""),
        intent: "admin_takeover",
        raw: { source: "startHumanTakeover" }
    }).catch(err => console.error("Supabase admin takeover log error:", err.message));

    console.log(`Human admin takeover detected and bot paused ${Number(currentWorkingSettings().admin_pause_minutes || 10)} minutes:`, senderId, adminText);
}

async function handleProductMediaRequest(senderId, customerMessage, currentHistoryText, state) {
    const productType = state.currentTopic || detectProductType(customerMessage, currentHistoryText);
    aiTrace(senderId, "04-PHOTO-INTENT", { productType, message: customerMessage });

    if (!productType) {
        const ask = buildUnknownProductClarifyReply();
        await sendMessage(senderId, ask);
        conversations[senderId].push(`Bot: ${ask} | TIME:${Date.now()} | PRODUCT:unknown | PHOTO_NEED_TOPIC_NO_SLIDE`);
        saveConversations(conversations);
        return true;
    }

    state.currentTopic = productType;
    state.productType = productType;
    state.lastCarouselTime = Date.now();
    saveCustomerStates(customerStates);

    try {
        const productRow = await findBestProductRow(productType, customerMessage, currentHistoryText);
        aiTrace(senderId, "05-PRODUCT-ROW", { productType, group: productRow?.group || "", path: productRow?.path || "", price_min: productRow?.price_min || "", price_max: productRow?.price_max || "" });

        // AIGUKA 4.2.7: không gửi tin giới thiệu trước carousel để tránh 2 tin liên tiếp.
        // Sau khi gửi slide, bot chỉ gửi 1 tin duy nhất theo trong/ngoài giờ làm việc.
        const mediaResult = await sendCarouselByProduct(senderId, productType, productRow, state, customerMessage);
        aiTrace(senderId, "06-PHOTO-RULE", mediaResult || {});

        if (mediaResult && mediaResult.sent) {
            state.lastSampleTime = Date.now();
            state.lastCarouselTime = Date.now();
            state.stage = "GET_PHONE";
            state.sampleSentCount = Number(state.sampleSentCount || 0) + 1;
            if (!Array.isArray(state.carouselSent)) state.carouselSent = [];
            state.carouselSent.push({ topic: productType, time: Date.now(), mode: mediaResult.mode || "unknown" });
            state.carouselSent = state.carouselSent.slice(-20);

            const close = buildPostSlideReply(productType, isOfficeHoursVN());
            await sendMessage(senderId, close);
            conversations[senderId].push(`Bot: ${close} | TIME:${Date.now()} | PRODUCT:${productType} | PHOTO_RULE:${mediaResult.mode || "unknown"}`);
        } else {
            const fallback = "Dạ hiện em chưa gửi được ảnh trực tiếp trên Messenger. Anh để lại SĐT/Zalo, bên em gửi album mẫu và báo giá chi tiết cho anh ngay nhé?";
            await sendMessage(senderId, fallback);
            conversations[senderId].push(`Bot: ${fallback} | TIME:${Date.now()} | PRODUCT:${productType} | PHOTO_FALLBACK`);
            state.lastCarouselTime = null;
        }

        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return true;
    } catch (error) {
        console.error("Product media request error:", error);
        aiTrace(senderId, "06-PHOTO-ERROR", { message: error.message });
        const fallback = "Dạ em đang chưa gửi được mẫu trực tiếp trên Messenger. Anh để lại SĐT/Zalo, bên em gửi album mẫu qua Zalo cho rõ và không bị trôi tin nhé?";
        await sendMessage(senderId, fallback);
        conversations[senderId].push(`Bot: ${fallback} | TIME:${Date.now()} | PRODUCT:${productType} | PHOTO_EXCEPTION`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        return true;
    }
}

async function handleMessage(event) {
    // Log postback/quick button clicks too. Trước đây nhánh này return sớm nên mất message.
    if (!event.message && event.postback) {
        const senderId = event.sender?.id;
        const pageId = event.recipient?.id;
        if (!senderId) return;
        const payload = event.postback?.payload || "";
        const title = event.postback?.title || "";
        const text = title || payload || "[postback]";
        const state = ensureCustomerState(senderId);
        if (pageId && !state.lastPageId) state.lastPageId = pageId;
        recordInternalMessageEvent({ event, senderId, pageId, direction: "customer", text, state });
        await logMessageToSupabase({ event, senderId, pageId, role: "customer", text, messageType: "postback", productGroup: state.currentTopic || state.productType || "", intent: detectCustomerIntent(text), source: "meta_postback", raw: { source: "meta_postback", payload, title, event } });
        return;
    }
    if (!event.message) return;

    // 4.1.5 HOTFIX:
    // Customer message: sender = customer, recipient = page.
    // Echo/admin/page message: sender = page, recipient = customer.
    // Nếu dùng event.sender cho echo, bot sẽ khóa nhầm PAGE_ID thay vì khách => vẫn cướp lời sale.
    const isEcho = Boolean(event.message?.is_echo);
    const senderId = isEcho ? event.recipient?.id : event.sender?.id;
    const pageId = isEcho ? event.sender?.id : event.recipient?.id;
    if (!senderId) return;

    if (!conversations[senderId]) {
        conversations[senderId] = [];
    }

    const state = ensureCustomerState(senderId);
    if (pageId && !state.lastPageId) state.lastPageId = pageId;
    const now = Date.now();

    // Nếu admin/page trả lời thủ công, webhook sẽ gửi echo.
    // Bot tự phân biệt echo của chính bot với echo của admin bằng app_id + nội dung gần nhất đã lưu.
    // Admin trả lời => bot dừng ngay 10 phút. Admin trả lời tiếp => reset lại 10 phút.
    if (event.message.is_echo) {
        const echoText = getEchoTextFromEvent(event);
        aiTrace(senderId, "00-ECHO", { text: echoText, app_id: event.message.app_id || "", takeoverEnabled: shouldHandleEchoAsHumanAdmin(event) });
        if (shouldHandleEchoAsHumanAdmin(event) && !isOwnBotEcho(senderId, event)) {
            startHumanTakeover(senderId, echoText, now);
            logMessageToSupabase({ event, senderId, pageId, role: "admin", text: echoText, messageType: echoText.startsWith('[attachment:') ? 'attachment' : 'text', source: "meta_admin_echo" })
                .catch(err => console.error("Supabase admin log error:", err.message));
        } else {
            console.log("Echo ignored to keep bot replying:", senderId);
            // 4.0.5: không bỏ mất echo không phân loại được; lưu để audit/replay đầy đủ hơn.
            if (echoText) {
                logMessageToSupabase({ event, senderId, pageId, role: "echo_unknown", text: echoText, messageType: echoText.startsWith('[attachment:') ? 'attachment' : 'text', source: "meta_echo_unknown" })
                    .catch(err => console.error("Supabase echo_unknown log error:", err.message));
            }
        }
        return;
    }

    const customerMessage = getCustomerMessageFromEvent(event);
    if (!customerMessage) return;

    const messageId = event.message.mid || `${senderId}-${Date.now()}`;
    if (processedMessages.has(messageId)) {
        console.log("Duplicate message ignored:", messageId);
        return;
    }
    processedMessages.add(messageId);

    if (processedMessages.size > 2000) {
        processedMessages.clear();
        processedMessages.add(messageId);
    }

    // AIGUKA 3.8: lưu mọi tin nhắn khách trực tiếp từ Meta Webhook trước khi xử lý AI/Pancake.
    recordInternalMessageEvent({ event, senderId, pageId, direction: "customer", text: customerMessage, state });
    await logMessageToSupabase({ event, senderId, pageId, role: "customer", text: customerMessage, messageType: "text", productGroup: state.currentTopic || state.productType || "", source: "meta_customer_message" });

    // AIGUKA 4.0: chuyển toàn bộ khách hàng qua Workflow Engine mới.
    // Code quyết định: chờ admin 10p/5p, khóa sản phẩm, gửi welcome carousel, chống lặp flow.
    registerAndScheduleAiguka4CustomerMessage(senderId, event, customerMessage, now);
    return;

    // Nếu admin vừa vào tư vấn trong 10 phút, bot chỉ lưu tin khách.
    // Sau 10 phút nếu admin không trả lời tiếp, bot sẽ đọc lại hội thoại rồi mới trả lời.
    if (state.humanTakeoverUntil && now < Number(state.humanTakeoverUntil)) {
        console.log("Bot paused because human admin is handling:", senderId);
        conversations[senderId].push(`Khách: ${customerMessage} | TIME:${now} | PRODUCT:${state.currentTopic || "unknown"} | HUMAN_TAKEOVER_ACTIVE`);
        conversations[senderId] = conversations[senderId].slice(-80);
        state.lastCustomerTime = now;
        state.pendingHumanCustomer = true;
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        scheduleBotResumeAfterHumanTakeover(senderId);
        return;
    }

    console.log("Customer ID:", senderId);
    console.log("Customer Message:", customerMessage);
    aiTrace(senderId, "01-WEBHOOK", { text: customerMessage });

    const currentHistoryText = conversations[senderId].slice(-30).join(" ");

    const explicitTopic = detectExplicitTopic(customerMessage);
    if (explicitTopic) {
        if (state.currentTopic && state.currentTopic !== explicitTopic) {
            state.previousTopics.push({
                topic: state.currentTopic,
                time: now
            });
            state.previousTopics = state.previousTopics.slice(-10);
        }

        state.currentTopic = explicitTopic;
        state.productType = explicitTopic;
    }

    if (!state.currentTopic) {
        const detectedFromHistory = detectProductType(customerMessage, currentHistoryText);
        if (detectedFromHistory) {
            state.currentTopic = detectedFromHistory;
            state.productType = detectedFromHistory;
        }
    }

    if (isDontCallMessage(customerMessage)) {
        state.preferMessenger = true;
        state.phoneRejected = true;
    }

    state.lastCustomerTime = now;

    if (!state.followUpOnceSent) {
        state.followUp8hSent = false;
    }

    if (hasPhoneOrContact(customerMessage)) {
        state.hasContact = true;
        state.stage = "HUMAN_HANDOVER";
    }

    conversations[senderId].push(`Khách: ${customerMessage} | TIME:${now} | PRODUCT:${state.currentTopic || "unknown"}`);
    conversations[senderId] = conversations[senderId].slice(-80);

    saveConversations(conversations);
    saveCustomerStates(customerStates);
    aiTrace(senderId, "02-STATE", { topic: state.currentTopic, stage: state.stage, hasContact: state.hasContact, phoneRejected: state.phoneRejected, preferMessenger: state.preferMessenger });

    // AIGUKA 4.2.8: địa chỉ/hotline/giờ mở cửa/bảo hành/lắp đặt trả lời trực tiếp, không gửi slide.
    if (isNoSlideServiceIntent(currentIntent)) {
        const reply = buildDirectReplyByIntent(state.currentTopic || state.productType || "", currentIntent, customerMessage, state, conversations[senderId] || []);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || "unknown"} | DIRECT_NO_SLIDE:${currentIntent}`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }

    // 3.9.11: Tin nhắn mở đầu/ký tự lạ phải hỏi nhóm sản phẩm, không đưa câu chung chung.
    if (isStarterOrUnclearMessage(customerMessage)) {
        const reply = buildStarterProductAsk();
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:unknown | STARTER_CLARIFY`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }

    // 3.9.11: Từ "bồn/bon" mơ hồ không được tự hiểu là bồn tắm hay combo.
    if (isAmbiguousBonQuery(customerMessage)) {
        const reply = buildAmbiguousBonReply();
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:ambiguous_bon | CLARIFY_BON`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }

    // 3.9.11: Bồn cầu thông minh là intent riêng; trả lời nhu cầu trước rồi mới xin SĐT/Zalo.
    if (isToiletOnlyQuestion(customerMessage)) {
        state.currentTopic = "toilet";
        state.productType = "toilet";
        state.stage = "GET_PHONE";
        state.askedPhone = true;
        state.lastPhoneAskTime = Date.now();
        const reply = buildSmartToiletReply();
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:toilet | TOILET_SMART_REPLY`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }

    // Nếu khách đã có SĐT/Zalo: không hỏi khai thác, không tư vấn lan man, chuyển chuyên viên.
    if (hasPhoneOrContact(customerMessage)) {
        aiTrace(senderId, "03-CONTACT-HANDOVER", { topic: state.currentTopic });
        const reply = buildContactHandoverReply(customerMessage, state);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || "unknown"} | HAS_CONTACT_HANDOVER`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }

    // 3.9.10: Xin mẫu/xem ảnh phải được ưu tiên trước flow khai thác nhu cầu.
    // Lý do: khách nhắn "Xin mẫu" sau auto-reply rất dễ bị stage NEED_ASKED hoặc echo takeover chặn.
    if (shouldSendCarousel(customerMessage)) {
        aiTrace(senderId, "03-PHOTO-REQUEST", { topic: state.currentTopic, message: customerMessage });
        await handleProductMediaRequest(senderId, customerMessage, currentHistoryText, state);
        return;
    }

    // Khách hỏi thương hiệu/hãng phải trả lời thương hiệu trước, không hỏi lệch sang nhu cầu phòng tắm/combo.
    if (isBrandQuestion(customerMessage)) {
        const reply = buildBrandReply(state.currentTopic || state.productType || detectProductType(customerMessage, currentHistoryText));
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || "unknown"} | BRAND_REPLY`);
        conversations[senderId] = conversations[senderId].slice(-80);
        state.stage = "GET_PHONE";
        state.askedPhone = true;
        state.lastPhoneAskTime = Date.now();
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }

    // Riêng bồn cầu/bệt chưa có bộ ảnh tự động riêng: không được hứa gửi ảnh bên dưới.
    if (isToiletOnlyQuestion(customerMessage) && shouldSendCarousel(customerMessage)) {
        const reply = buildToiletSampleFallback();
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:toilet | TOILET_NO_AUTO_IMAGE`);
        conversations[senderId] = conversations[senderId].slice(-80);
        state.stage = "GET_PHONE";
        state.askedPhone = true;
        state.lastPhoneAskTime = Date.now();
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }


    // Khách hỏi giá: chỉ báo khoảng giá min -> max từ Google Sheet, không báo giá cụ thể từng mẫu.
    if (isPriceRequest(customerMessage)) {
        const productTypeForPrice = state.currentTopic || state.productType || detectProductType(customerMessage, currentHistoryText);
        if (productTypeForPrice) {
            state.currentTopic = productTypeForPrice;
            state.productType = productTypeForPrice;

            const productRow = await findBestProductRow(productTypeForPrice, customerMessage, currentHistoryText);
            const reply = buildPriceRangeReply(productRow, productTypeForPrice);

            conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${productTypeForPrice} | PRICE_RANGE_ONLY`);
            conversations[senderId] = conversations[senderId].slice(-80);

            state.stage = "GET_PHONE";
            state.askedPhone = true;
            state.lastPhoneAskTime = Date.now();
            saveConversations(conversations);
            saveCustomerStates(customerStates);

            await sendMessage(senderId, reply);
            return;
        }
    }

    // Flow tư vấn mới:
    // Khách hỏi sản phẩm cụ thể -> xin số nhẹ. Nếu chưa cho thì khai thác 1-2 câu hỏi.
    // Khi khách trả lời lại nhu cầu -> xin SĐT/Zalo để tư vấn và gửi mẫu.
    if (!state.hasContact && !state.phoneRejected && !state.preferMessenger) {
        const productTypeForConsult = state.currentTopic || state.productType || detectProductType(customerMessage, currentHistoryText);

        if (state.stage === "NEED_ASKED" && state.lastConsultTopic && isMeaningfulNeedAnswer(customerMessage)) {
            const askPhone = buildPhoneAskAfterNeed(state.lastConsultTopic);
            conversations[senderId].push(`Bot: ${askPhone} | TIME:${Date.now()} | PRODUCT:${state.lastConsultTopic}`);
            conversations[senderId] = conversations[senderId].slice(-80);

            state.stage = "GET_PHONE";
            state.askedPhone = true;
            state.lastPhoneAskTime = Date.now();
            saveConversations(conversations);
            saveCustomerStates(customerStates);

            await sendMessage(senderId, askPhone);
            return;
        }

        if (productTypeForConsult && isSpecificConsultRequest(customerMessage, state) && state.stage !== "NEED_ASKED" && state.stage !== "GET_PHONE") {
            state.currentTopic = productTypeForConsult;
            state.productType = productTypeForConsult;
            state.stage = "NEED_ASKED";
            state.consultAskCount = Number(state.consultAskCount || 0) + 1;
            state.consultStartedAt = Date.now();
            state.lastConsultTopic = productTypeForConsult;

            const question = buildNeedQuestion(productTypeForConsult);
            const askPhone = "Anh cho em xin SĐT/Zalo để bên em gửi mẫu và tư vấn nhanh hơn nhé. " + question;

            conversations[senderId].push(`Bot: ${askPhone} | TIME:${Date.now()} | PRODUCT:${productTypeForConsult}`);
            conversations[senderId] = conversations[senderId].slice(-80);

            state.askedPhone = true;
            state.lastPhoneAskTime = Date.now();
            saveConversations(conversations);
            saveCustomerStates(customerStates);

            await sendMessage(senderId, askPhone);
            return;
        }
    }

    // Sản phẩm ngoài kịch bản: không để GPT trả lời lung tung.
    if (isProbablyUnsupportedProduct(customerMessage, state)) {
        const reply = buildUnsupportedProductReply();
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:unsupported`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        await sendMessage(senderId, reply);
        return;
    }

    // Khách không tiện nghe máy: bám chủ đề cũ, không hỏi lại sản phẩm từ đầu.
    if (isDontCallMessage(customerMessage)) {
        const reply = buildDontCallReply(state.currentTopic);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || "unknown"}`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
        return;
    }

    // Khách xin ảnh/mẫu/catalog đã được xử lý sớm ở nhánh PHOTO_REQUEST phía trên.


    const history = conversations[senderId].slice(-30).join("\n");

    console.log("Calling OpenAI...");
    aiTrace(senderId, "07-CALLING-OPENAI", { topic: state.currentTopic, historyLines: conversations[senderId].length });
    let aiReply = await getAIReply(history);

    // Sau 2-3 lượt có tín hiệu mua/hỏi giá thì xin số nhẹ, trừ khi khách đã nói không tiện nghe/gửi qua đây.
    if (shouldAskPhoneNow(customerMessage, state, conversations[senderId])) {
        const phoneAsk = buildPhoneAskByTopic(state.currentTopic || state.productType);
        if (!String(aiReply).toLowerCase().includes("sđt") && !String(aiReply).toLowerCase().includes("zalo") && !String(aiReply).toLowerCase().includes("số điện thoại")) {
            aiReply = `${aiReply}\n\n${phoneAsk}`;
        }
        state.askedPhone = true;
        state.lastPhoneAskTime = Date.now();
    }

    conversations[senderId].push(`Bot: ${aiReply} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || "unknown"}`);
    conversations[senderId] = conversations[senderId].slice(-80);

    saveConversations(conversations);
    saveCustomerStates(customerStates);

    console.log("AI Reply:", aiReply);
    await sendMessage(senderId, aiReply);
    aiTrace(senderId, "10-DONE", { mode: "openai", topic: state.currentTopic });

    // Bỏ auto-carousel sau GPT để tránh trường hợp GPT nói một câu rồi code chen thêm ảnh/tin chốt không đúng nhịp.
    // Ảnh chỉ gửi khi khách xin ảnh/mẫu rõ ràng ở nhánh shouldSendCarousel phía trên.
}


app.post('/webhook', async (req, res) => {
    console.log("========== WEBHOOK HIT ==========");
    console.log(JSON.stringify(req.body, null, 2));

    const body = req.body;

    if (body.object !== 'page') {
        return res.sendStatus(404);
    }

    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
            try {
                await handleMessage(event);
            } catch (error) {
                console.error("Webhook handleMessage error:", error);
                // Không return cả webhook vì một lỗi một event có thể làm các event sau không xử lý.
                // Lỗi đã có AI trace, nhân viên/Pancake có thể xử lý nếu cần.
            }
        }
    }
});



// ===== PANCAKE REPORT MODULE =====
// Mục đích: đọc dữ liệu hội thoại từ Pancake và thống kê khách có số/chưa có số.
// Cần thêm biến môi trường trên Render:
// PANCAKE_PAGE_ID=104810069068200
// PANCAKE_PAGE_ACCESS_TOKEN=page_access_token_cua_anh

const PANCAKE_PAGE_ID = process.env.PANCAKE_PAGE_ID;
const PANCAKE_PAGE_ACCESS_TOKEN = process.env.PANCAKE_PAGE_ACCESS_TOKEN;

function pancakeCleanHtml(html = "") {
    return String(html)
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
}

function pancakeGetTagNames(conv) {
    if (!Array.isArray(conv.tags)) return [];
    return conv.tags
        .filter(Boolean)
        .map(tag => tag.text)
        .filter(Boolean);
}

function pancakeGetPhones(conv) {
    if (!Array.isArray(conv.recent_phone_numbers)) return [];

    return conv.recent_phone_numbers
        .map(item => item.phone_number || item.captured)
        .filter(Boolean);
}

function dashboardNormalizeAdId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const direct = raw.match(/^[0-9]{8,30}$/);
    if (direct) return raw;
    const match = raw.match(/[0-9]{8,30}/);
    return match ? match[0] : "";
}

function pancakeExtractAdIds(source, depth = 0, out = new Set()) {
    if (!source || depth > 6) return Array.from(out);

    if (Array.isArray(source)) {
        for (const item of source) pancakeExtractAdIds(item, depth + 1, out);
        return Array.from(out);
    }

    if (typeof source !== "object") {
        const id = dashboardNormalizeAdId(source);
        if (id) out.add(id);
        return Array.from(out);
    }

    for (const [key, value] of Object.entries(source)) {
        const k = String(key || "").toLowerCase();
        const looksLikeAdKey = [
            "ad_id", "adid", "ad_ids", "facebook_ad_id", "fb_ad_id", "adid",
            "source_ad_id", "origin_ad_id", "ref_ad_id"
        ].some(name => k === name || k.endsWith(name));

        if (looksLikeAdKey) {
            if (Array.isArray(value)) {
                for (const item of value) {
                    const id = dashboardNormalizeAdId(item);
                    if (id) out.add(id);
                    if (item && typeof item === "object") pancakeExtractAdIds(item, depth + 1, out);
                }
            } else {
                const id = dashboardNormalizeAdId(value);
                if (id) out.add(id);
                if (value && typeof value === "object") pancakeExtractAdIds(value, depth + 1, out);
            }
            continue;
        }

        // Một số payload Pancake lồng thông tin quảng cáo trong object ad/ad_info/referral.
        if (["ad", "ads", "ad_info", "adinfo", "referral", "ref", "metadata", "extra", "extra_info"].includes(k)) {
            pancakeExtractAdIds(value, depth + 1, out);
        }
    }

    return Array.from(out);
}

function pancakeClassifyProduct(text = "") {
    const t = String(text).toLowerCase();

    if (detectExplicitTopic(text) === "vanity") return "Tủ chậu gương";
    if (detectExplicitTopic(text) === "toilet") return "Bồn cầu";
    if (detectExplicitTopic(text) === "kitchen") return "Bếp";
    if (detectExplicitTopic(text) === "fan") return "Quạt";

    if (
        t.includes("quạt") ||
        t.includes("quat") ||
        t.includes("guka") ||
        t.includes("cánh") ||
        t.includes("canh") ||
        t.includes("động cơ") ||
        t.includes("dong co")
    ) {
        return "Quạt";
    }

    if (
        t.includes("bồn cầu") ||
        t.includes("bon cau") ||
        t.includes("thiết bị vệ sinh") ||
        t.includes("thiet bi ve sinh") ||
        t.includes("sen") ||
        t.includes("lavabo") ||
        t.includes("vòi") ||
        t.includes("voi") ||
        t.includes("chậu rửa") ||
        t.includes("chau rua")
    ) {
        return "Thiết bị vệ sinh";
    }

    if (
        t.includes("bếp") ||
        t.includes("bep") ||
        t.includes("hút mùi") ||
        t.includes("hut mui") ||
        t.includes("chậu rửa bát") ||
        t.includes("chau rua bat")
    ) {
        return "Bếp";
    }

    if (t.includes("bồn tắm") || t.includes("bon tam")) {
        return "Bồn tắm";
    }

    if (
        t.includes("combo") ||
        t.includes("phòng tắm") ||
        t.includes("phong tam") ||
        t.includes("nhà tắm") ||
        t.includes("nha tam")
    ) {
        return "Combo phòng tắm";
    }

    return "Khác";
}

function pancakeIsHotLead(conv) {
    const text = String(conv.snippet || "").toLowerCase();

    return (
        text.includes("giá") ||
        text.includes("gia") ||
        text.includes("bao nhiêu") ||
        text.includes("bao nhieu") ||
        text.includes("địa chỉ") ||
        text.includes("dia chi") ||
        text.includes("mua") ||
        text.includes("lắp") ||
        text.includes("lap") ||
        text.includes("còn hàng") ||
        text.includes("con hang") ||
        text.includes("xem mẫu") ||
        text.includes("xem mau") ||
        text.includes("gửi mẫu") ||
        text.includes("gui mau") ||
        text.includes("xin mẫu") ||
        text.includes("xin mau")
    );
}

function pancakeBuildCustomerRow(conv) {
    const tags = pancakeGetTagNames(conv);
    const phones = pancakeGetPhones(conv);
    const snippet = pancakeCleanHtml(conv.snippet || "");
    const product = pancakeClassifyProduct(snippet);

    return {
        name: conv.from?.name || "Không rõ tên",
        conversation_id: conv.id,
        type: conv.type,
        updated_at: conv.updated_at,
        message_count: conv.message_count || 0,
        has_phone: Boolean(conv.has_phone),
        phones,
        product,
        hot_lead: pancakeIsHotLead(conv),
        tags,
        snippet,
        ad_ids: pancakeExtractAdIds(conv),
        ad_name: conv.ad_name || conv.ad?.name || conv.referral?.ad_name || "",
        ad_account_id: conv.ad_account_id || conv.account_id || "",
        ad_account_name: conv.ad_account_name || conv.account_name || "",
        campaign_name: conv.campaign_name || conv.ad?.campaign_name || "",
        adset_name: conv.adset_name || conv.ad?.adset_name || ""
    };
}

async function pancakeFetchConversations(limit) {
    if (!PANCAKE_PAGE_ID || !PANCAKE_PAGE_ACCESS_TOKEN) {
        throw new Error("Thiếu PANCAKE_PAGE_ID hoặc PANCAKE_PAGE_ACCESS_TOKEN trong Render Environment");
    }

    // Pancake endpoint conversations thường trả tối đa khoảng 60 hội thoại/lần.
    // Muốn lấy 200-500 hội thoại thì phải gọi nhiều lần bằng last_conversation_id.
    const targetLimit = Math.min(Math.max(Number(limit) || 300, 1), 500);
    const allConversations = [];
    const seenIds = new Set();

    let lastConversationId = null;
    let safetyCounter = 0;

    while (allConversations.length < targetLimit && safetyCounter < 10) {
        safetyCounter++;

        let url =
            `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversations` +
            `?page_access_token=${encodeURIComponent(PANCAKE_PAGE_ACCESS_TOKEN)}`;

        if (lastConversationId) {
            url += `&last_conversation_id=${encodeURIComponent(lastConversationId)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (!data.success) {
            throw new Error(`Pancake API lỗi: ${JSON.stringify(data)}`);
        }

        const batch = Array.isArray(data.conversations) ? data.conversations : [];

        if (batch.length === 0) {
            break;
        }

        for (const conv of batch) {
            if (!conv || !conv.id) continue;
            if (seenIds.has(conv.id)) continue;

            seenIds.add(conv.id);
            allConversations.push(conv);

            if (allConversations.length >= targetLimit) {
                break;
            }
        }

        const lastItem = batch[batch.length - 1];
        if (!lastItem || !lastItem.id || lastItem.id === lastConversationId) {
            break;
        }

        lastConversationId = lastItem.id;

        // Nếu Pancake trả ít hơn 60 hội thoại thì thường là đã hết dữ liệu tiếp theo.
        if (batch.length < 60) {
            break;
        }
    }

    return allConversations.slice(0, targetLimit);
}


// ===== AIGUKA 4.1 UNIFIED META + PANCAKE TIMELINE =====
// Mục tiêu: Supabase không chỉ lưu Meta webhook nữa, mà có thể đồng bộ thêm Pancake
// để audit thấy cả phần nhân viên/admin xử lý. Vì Pancake API có thể thay đổi shape,
// phần parser dưới đây cố tình mềm: tìm message trong nhiều cấu trúc khác nhau.
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function pancakeToDbProductGroup(productLabel = "", text = "") {
    const explicit = detectExplicitTopic(text || "");
    if (explicit) return toDbProductGroup(explicit);
    const p = String(productLabel || "").toLowerCase();
    if (p.includes("quạt") || p.includes("quat")) return "fan";
    if (p.includes("bếp") || p.includes("bep")) return "kitchen";
    if (p.includes("tủ chậu") || p.includes("tu chau") || p.includes("vanity") || p.includes("gương")) return "vanity";
    if (p.includes("bồn cầu") || p.includes("bon cau")) return "toilet";
    if (p.includes("combo")) return "combo";
    if (p.includes("bồn tắm") || p.includes("bon tam")) return "bathtub";
    if (p.includes("thiết bị") || p.includes("thiet bi") || p.includes("vệ sinh") || p.includes("ve sinh")) return "bathroom";
    return toDbProductGroup(detectExplicitTopic(text || "") || "") || null;
}

function pancakeCustomerSenderId(conv = {}) {
    return String(
        conv.from?.id ||
        conv.from_id ||
        conv.customer_id ||
        conv.user_id ||
        conv.psid ||
        conv.sender_id ||
        conv.fb_id ||
        conv.id ||
        ""
    );
}

function pancakeMessageText(msg = {}) {
    return pancakeCleanHtml(
        msg.message || msg.text || msg.content || msg.body || msg.snippet || msg.comment || msg.title || ""
    );
}

function pancakeMessageCreatedAt(msg = {}, conv = {}) {
    return msg.created_at || msg.inserted_at || msg.updated_at || msg.sent_at || msg.timestamp || conv.updated_at || new Date().toISOString();
}

function pancakeAttachmentUrl(msg = {}) {
    const candidates = [];
    if (Array.isArray(msg.attachments)) candidates.push(...msg.attachments);
    if (Array.isArray(msg.images)) candidates.push(...msg.images);
    if (Array.isArray(msg.photos)) candidates.push(...msg.photos);
    if (msg.attachment) candidates.push(msg.attachment);
    for (const item of candidates) {
        if (!item) continue;
        if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
        const url = item.url || item.src || item.image_url || item.preview_url || item.file_url || item.original_url;
        if (url && /^https?:\/\//i.test(String(url))) return String(url);
    }
    return "";
}

function inferPancakeMessageRole(msg = {}, conv = {}) {
    const fromId = String(msg.from?.id || msg.from_id || msg.sender_id || msg.user_id || msg.uid || "");
    const fromType = String(msg.from?.type || msg.sender_type || msg.type || msg.role || "").toLowerCase();
    const pageId = String(PANCAKE_PAGE_ID || conv.page_id || "");
    const customerId = pancakeCustomerSenderId(conv);

    if (msg.is_from_page === true || msg.from_page === true || msg.is_page === true) return "admin";
    if (msg.is_admin === true || msg.admin_id || msg.user?.is_admin) return "admin";
    if (fromType.includes("admin") || fromType.includes("page") || fromType.includes("user")) return "admin";
    if (pageId && fromId && fromId === pageId) return "admin";
    if (customerId && fromId && fromId === customerId) return "customer";
    if (msg.is_echo === true) return "admin";
    return "pancake_unknown";
}

function looksLikePancakeMessage(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const hasText = Boolean(obj.message || obj.text || obj.content || obj.body || obj.comment || obj.snippet || obj.title);
    const hasAttachment = Array.isArray(obj.attachments) || Array.isArray(obj.images) || obj.attachment;
    const hasTime = Boolean(obj.created_at || obj.inserted_at || obj.updated_at || obj.sent_at || obj.timestamp);
    const hasActor = Boolean(obj.from || obj.from_id || obj.sender_id || obj.user_id || obj.admin_id || obj.is_from_page !== undefined);
    return (hasText || hasAttachment) && (hasTime || hasActor);
}

function collectPancakeMessages(node, out = [], depth = 0) {
    if (!node || depth > 8) return out;
    if (Array.isArray(node)) {
        for (const item of node) collectPancakeMessages(item, out, depth + 1);
        return out;
    }
    if (typeof node !== "object") return out;

    if (looksLikePancakeMessage(node)) out.push(node);

    for (const [key, value] of Object.entries(node)) {
        if (!value) continue;
        const k = String(key || "").toLowerCase();
        if (["messages", "conversation_messages", "data", "items", "comments", "list", "results"].includes(k)) {
            collectPancakeMessages(value, out, depth + 1);
        }
    }
    return out;
}

async function pancakeFetchConversationDetails(conversationId) {
    if (!PANCAKE_PAGE_ID || !PANCAKE_PAGE_ACCESS_TOKEN || !conversationId) return { ok: false, messages: [], attempts: [] };
    const token = encodeURIComponent(PANCAKE_PAGE_ACCESS_TOKEN);
    const id = encodeURIComponent(conversationId);
    const urls = [
        `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversations/${id}?page_access_token=${token}`,
        `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversations/${id}/messages?page_access_token=${token}`,
        `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversation_messages?conversation_id=${id}&page_access_token=${token}`,
        `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/messages?conversation_id=${id}&page_access_token=${token}`
    ];
    const attempts = [];
    const collected = [];
    const seen = new Set();

    for (const url of urls) {
        try {
            const response = await fetch(url);
            const raw = await response.text();
            let data = null;
            try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
            const messages = collectPancakeMessages(data, []);
            attempts.push({ status: response.status, count: messages.length });
            for (const msg of messages) {
                const key = String(msg.id || msg.mid || msg.created_at || msg.inserted_at || "") + "|" + pancakeMessageText(msg).slice(0, 80);
                if (seen.has(key)) continue;
                seen.add(key);
                collected.push(msg);
            }
            if (messages.length) break;
        } catch (error) {
            attempts.push({ status: "error", error: error.message });
        }
    }
    return { ok: collected.length > 0, messages: collected, attempts };
}

async function supabaseFindExistingPancakeMessage({ senderId, role, createdAt, externalId = "", text = "" }) {
    if (!supabaseIsReady() || !senderId) return null;
    try {
        if (externalId) {
            const rowsByExternal = await supabaseRequest(
                `messages?sender_id=eq.${encodeURIComponent(String(senderId))}&raw->>pancake_message_id=eq.${encodeURIComponent(String(externalId))}&select=id&limit=1`,
                { method: "GET" }
            );
            if (Array.isArray(rowsByExternal) && rowsByExternal[0]) return rowsByExternal[0];
        }
    } catch (_) {}
    try {
        if (!role || !createdAt) return null;
        const rows = await supabaseRequest(
            `messages?sender_id=eq.${encodeURIComponent(String(senderId))}&role=eq.${encodeURIComponent(String(role))}&created_at=eq.${encodeURIComponent(String(createdAt))}&text=eq.${encodeURIComponent(String(text || ""))}&select=id&limit=1`,
            { method: "GET" }
        );
        return Array.isArray(rows) ? rows[0] : null;
    } catch (_) {
        return null;
    }
}

async function logPancakeConversationSummaryToSupabase(conv = {}) {
    const row = pancakeBuildCustomerRow(conv);
    const senderId = pancakeCustomerSenderId(conv);
    if (!senderId) return { ok: false, reason: "missing_sender" };
    const productGroup = pancakeToDbProductGroup(row.product, row.snippet);
    const contact = detectContactInfo([row.snippet || "", ...(row.phones || [])].join(" "));
    const phone = row.phones[0] || contact.phone || "";
    const customer = await supabaseUpsertCustomer({
        senderId,
        pageId: PANCAKE_PAGE_ID || "",
        phone,
        zalo: contact.zalo_phone || "",
        contactInfo: { ...contact, has_zalo: contact.has_zalo || row.tags.includes("Zalo") },
        productGroup,
        source: "pancake_sync"
    });
    const conversation = await supabaseGetOrCreateConversation({
        customerId: customer?.id,
        senderId,
        pageId: PANCAKE_PAGE_ID || "",
        adId: (row.ad_ids || [])[0] || "",
        postId: "",
        productGroup,
        createdAt: conv.updated_at || new Date().toISOString(),
        source: "pancake"
    });
    await logBotEventToSupabase({
        senderId,
        customerId: customer?.id,
        conversationId: conversation?.id,
        eventType: "PANCAKE_CONVERSATION_SYNC",
        eventData: { conversation_id: row.conversation_id, tags: row.tags, phones: row.phones, product: row.product, snippet: row.snippet, ad_ids: row.ad_ids, updated_at: row.updated_at }
    });
    return { ok: true, customer, conversation, row };
}

async function logPancakeMessageToSupabase(conv = {}, msg = {}) {
    const summary = pancakeBuildCustomerRow(conv);
    const senderId = pancakeCustomerSenderId(conv);
    if (!senderId) return { ok: false, reason: "missing_sender" };
    const text = pancakeMessageText(msg);
    const attachmentUrl = pancakeAttachmentUrl(msg);
    const createdAt = new Date(pancakeMessageCreatedAt(msg, conv));
    const createdAtIso = Number.isNaN(createdAt.getTime()) ? new Date().toISOString() : createdAt.toISOString();
    const role = inferPancakeMessageRole(msg, conv);
    const productGroup = pancakeToDbProductGroup(summary.product, text || summary.snippet);
    const intent = detectCustomerIntent(text);

    const externalId = msg.id || msg.mid || msg.message_id || "";
    const existing = await supabaseFindExistingPancakeMessage({ senderId, role, createdAt: createdAtIso, externalId, text });
    if (existing?.id) return { ok: true, skipped: true, id: existing.id };

    const contact = detectContactInfo(text, msg.attachments || msg.images || []);
    const customer = await supabaseUpsertCustomer({
        senderId,
        pageId: PANCAKE_PAGE_ID || "",
        phone: (summary.phones || [])[0] || contact.phone || "",
        zalo: contact.zalo_phone || "",
        contactInfo: { ...contact, has_zalo: contact.has_zalo || summary.tags.includes("Zalo") },
        productGroup,
        source: "pancake_sync"
    });
    const conversation = await supabaseGetOrCreateConversation({
        customerId: customer?.id,
        senderId,
        pageId: PANCAKE_PAGE_ID || "",
        adId: (summary.ad_ids || [])[0] || "",
        postId: "",
        productGroup,
        createdAt: createdAtIso,
        source: "pancake"
    });
    const inserted = await supabaseRequest("messages", {
        method: "POST",
        body: JSON.stringify({
            conversation_id: conversation?.id || null,
            customer_id: customer?.id || null,
            sender_id: String(senderId),
            page_id: PANCAKE_PAGE_ID || null,
            role,
            message_type: attachmentUrl ? "attachment" : "text",
            text: text || (attachmentUrl ? "[pancake attachment]" : ""),
            attachment_url: attachmentUrl || null,
            raw: { source: "pancake_sync", pancake_conversation_id: conv.id, pancake_message_id: externalId || null, contact_info: contact, message: msg },
            ad_id: (summary.ad_ids || [])[0] || null,
            post_id: null,
            product_group: productGroup || null,
            intent: intent || null,
            source: "pancake_sync",
            external_message_id: externalId || null,
            created_at: createdAtIso
        })
    });

    // AIGUKA 4.2.5: nếu Pancake cho thấy sale/admin đã trả lời, khóa quyền hội thoại cho sale.
    // Điều này bù cho trường hợp Meta echo không báo về server nhưng Pancake đã có tin nhân viên.
    if (role === "admin") {
        const ageMs = Date.now() - createdAt.getTime();
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 6 * 60 * 60 * 1000) {
            const hist = conversations[senderId] || [];
            const exists = hist.some(line => String(line || "").startsWith("Admin:") && String(line || "").includes(text || "[pancake attachment]"));
            if (!exists) {
                startHumanTakeover(senderId, text || "[pancake attachment]", Date.now());
            } else {
                cancelBotReplyBecauseSaleAnswered(senderId, "pancake_admin_sync");
            }
        }
    }

    return { ok: true, message: Array.isArray(inserted) ? inserted[0] : inserted, role };
}

app.get('/pancake-sync-to-supabase', async (req, res) => {
    try {
        if (!supabaseIsReady()) return res.status(400).json({ ok: false, error: "Supabase chưa sẵn sàng" });
        const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
        const details = String(req.query.details || "1") !== "0";
        const delayMs = Math.min(Math.max(Number(req.query.delay_ms) || 250, 0), 2000);
        const conversations = await pancakeFetchConversations(limit);
        const result = { ok: true, limit, conversations: conversations.length, summaries: 0, messages: 0, admin: 0, customer: 0, unknown: 0, errors: [] };

        for (const conv of conversations) {
            try {
                await logPancakeConversationSummaryToSupabase(conv);
                result.summaries++;
                if (details) {
                    const detail = await pancakeFetchConversationDetails(conv.id);
                    for (const msg of detail.messages || []) {
                        const r = await logPancakeMessageToSupabase(conv, msg);
                        if (r?.ok && !r.skipped) {
                            result.messages++;
                            if (r.role === "admin") result.admin++;
                            else if (r.role === "customer") result.customer++;
                            else result.unknown++;
                        }
                    }
                    if (!detail.ok) result.errors.push({ conversation_id: conv.id, issue: "no_detail_messages", attempts: detail.attempts });
                    if (delayMs) await sleep(delayMs);
                }
            } catch (error) {
                result.errors.push({ conversation_id: conv?.id, error: error.message });
            }
        }
        res.json(result);
    } catch (error) {
        console.error("pancake-sync-to-supabase error:", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/supabase-replay', async (req, res) => {
    try {
        if (!supabaseIsReady()) return res.status(400).json({ ok: false, error: "Supabase chưa sẵn sàng" });
        const senderId = String(req.query.sender_id || req.query.senderId || "").trim();
        const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
        if (!senderId) return res.status(400).json({ ok: false, error: "Thiếu sender_id" });
        const rows = await supabaseRequest(
            `messages?sender_id=eq.${encodeURIComponent(senderId)}&select=created_at,role,message_type,text,attachment_url,product_group,intent,ad_id,post_id,raw&order=created_at.asc&limit=${limit}`,
            { method: "GET" }
        );
        res.json({ ok: true, sender_id: senderId, count: Array.isArray(rows) ? rows.length : 0, messages: rows });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/supabase-audit-summary', async (req, res) => {
    try {
        if (!supabaseIsReady()) return res.status(400).json({ ok: false, error: "Supabase chưa sẵn sàng" });
        const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
        const rows = await supabaseRequest(
            `messages?select=created_at,role,text,product_group,intent,sender_id,message_type&order=created_at.desc&limit=${limit}`,
            { method: "GET" }
        );
        const list = Array.isArray(rows) ? rows : [];
        const byRole = {};
        for (const r of list) byRole[r.role || "unknown"] = (byRole[r.role || "unknown"] || 0) + 1;
        const wrongProductComplaints = list.filter(r => detectWrongProductComplaint(r.text || ""));
        res.json({
            ok: true,
            checked: list.length,
            by_role: byRole,
            missing_product_group: list.filter(r => !r.product_group).length,
            missing_intent: list.filter(r => !r.intent).length,
            wrong_product_complaints: wrongProductComplaints.length,
            by_product_group: list.reduce((m, r) => { const k = r.product_group || "NULL"; m[k] = (m[k] || 0) + 1; return m; }, {}),
            by_intent: list.reduce((m, r) => { const k = r.intent || "NULL"; m[k] = (m[k] || 0) + 1; return m; }, {}),
            sample_wrong_product: wrongProductComplaints.slice(0, 10)
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});



app.get('/ad-mapping-admin', (req, res) => {
    res.redirect('/admin/ad-mapping.html');
});


app.get('/api/ad-mapping/meta', async (req, res) => {
    try {
        const sync = String(req.query.sync || "") === "1" || String(req.query.sync || "").toLowerCase() === "true";
        const result = await buildMetaAdMappingRows({ sync });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/ad-mapping/sync-meta', async (req, res) => {
    try {
        const result = await buildMetaAdMappingRows({ sync: true });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/ad-mapping/seed', (req, res) => {
    res.json({ success: true, rows: AD_MAPPING_SEED_ROWS.map(normalizeAdMappingRow), count: AD_MAPPING_SEED_ROWS.length });
});

app.get('/api/ad-mapping', async (req, res) => {
    try {
        const force = String(req.query.reload || "") === "1";
        if (force || !adMappingCache.loadedAt) await loadAdMappingsFromSupabase();
        res.json({ success: true, source: adMappingCache.source, loadedAt: adMappingCache.loadedAt, rows: adMappingCache.rows || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/ad-mapping/reload', async (req, res) => {
    try {
        await loadAdMappingsFromSupabase();
        res.json({ success: true, source: adMappingCache.source, loadedAt: adMappingCache.loadedAt, count: adMappingCache.rows.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/ad-mapping/bulk', async (req, res) => {
    try {
        const rows = Array.isArray(req.body?.rows) ? req.body.rows.map(normalizeAdMappingRow).filter(x => x.ad_id) : [];
        if (!rows.length) return res.status(400).json({ success: false, error: "Không có dòng hợp lệ. Mỗi dòng cần có ad_id." });
        if (!supabaseIsReady()) {
            adMappingCache = { byKey: indexAdMappingRows(rows), rows, loadedAt: new Date().toISOString(), source: "memory_only_supabase_disabled" };
            return res.json({ success: true, warning: "Supabase chưa bật, dữ liệu mới chỉ lưu RAM. Bật SUPABASE_ENABLED để lưu bền vững.", count: rows.length });
        }
        const saved = await supabaseRequest(`${AD_MAPPING_TABLE}?on_conflict=ad_id`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(rows)
        });
        await loadAdMappingsFromSupabase();
        res.json({ success: true, count: Array.isArray(saved) ? saved.length : rows.length, source: adMappingCache.source });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});



// ===== AIGUKA 4.2.3 ADMIN API: PRODUCT ITEMS + WORKING SETTINGS =====
app.get('/api/product-items', async (req, res) => {
    try {
        const force = String(req.query.reload || "") === "1";
        if (force || !productItemsCache.loadedAt) await loadProductItemsFromSupabase();
        res.json({ success: true, source: productItemsCache.source, loadedAt: productItemsCache.loadedAt, rows: productItemsCache.rows || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/product-items/reload', async (req, res) => {
    try {
        await loadProductItemsFromSupabase();
        res.json({ success: true, source: productItemsCache.source, loadedAt: productItemsCache.loadedAt, count: productItemsCache.rows.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/product-items/bulk', async (req, res) => {
    try {
        const rows = Array.isArray(req.body?.rows) ? req.body.rows.map(normalizeProductItemRow).filter(x => x.product_item_key && x.product_item_name) : [];
        if (!rows.length) return res.status(400).json({ success: false, error: "Không có dòng hợp lệ. Cần product_item_key và product_item_name." });
        if (!supabaseIsReady()) {
            productItemsCache = { rows, byKey: indexProductItems(rows), loadedAt: new Date().toISOString(), source: "memory_only_supabase_disabled" };
            return res.json({ success: true, warning: "Supabase chưa bật, dữ liệu mới chỉ lưu RAM.", count: rows.length });
        }
        const saved = await supabaseRequest(`${PRODUCT_ITEMS_TABLE}?on_conflict=product_item_key`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(rows)
        });
        await loadProductItemsFromSupabase();
        res.json({ success: true, count: Array.isArray(saved) ? saved.length : rows.length, source: productItemsCache.source });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


app.get('/api/bot-reply-switch', (req, res) => {
    res.json({ success: true, reply_enabled: isBotReplyEnabled(), source: 'runtime_memory', env_default: String(process.env.BOT_REPLY_ENABLED || 'false') });
});

app.post('/api/bot-reply-switch', (req, res) => {
    const enabled = req.body?.reply_enabled === true || req.body?.enabled === true || String(req.body?.reply_enabled || req.body?.enabled || '').toLowerCase() === 'true';
    setBotReplyEnabled(enabled);
    res.json({ success: true, reply_enabled: isBotReplyEnabled(), source: 'runtime_memory' });
});

app.get('/api/working-settings', async (req, res) => {
    try {
        await loadWorkingSettingsFromSupabase();
        res.json({ success: true, settings: currentWorkingSettings() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/working-settings/reload', async (req, res) => {
    try {
        await loadWorkingSettingsFromSupabase();
        res.json({ success: true, source: currentWorkingSettings().source, settings: currentWorkingSettings() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/working-settings', async (req, res) => {
    try {
        const payload = {
            setting_key: "default",
            timezone: "Asia/Ho_Chi_Minh",
            work_start: req.body?.work_start || "08:00",
            work_end: req.body?.work_end || "22:00",
            is_open: req.body?.is_open !== false,
            holiday_mode: Boolean(req.body?.holiday_mode),
            staff_online_count: Number(req.body?.staff_online_count || 1),
            admin_pause_minutes: Math.max(1, Number(req.body?.admin_pause_minutes || 10)),
            customer_wait_minutes: Math.max(0, Number(req.body?.customer_wait_minutes || 5)),
            outside_wait_minutes: Math.max(0, Number(req.body?.outside_wait_minutes || req.body?.customer_wait_minutes || 5)),
            carousel_cooldown_minutes: Math.max(1, Number(req.body?.carousel_cooldown_minutes || 5)),
            note: String(req.body?.note || ""),
            updated_at: new Date().toISOString()
        };
        if (!supabaseIsReady()) {
            workingSettingsCache = { ...workingSettingsCache, ...payload, loadedAt: new Date().toISOString(), source: "memory_only_supabase_disabled" };
            return res.json({ success: true, warning: "Supabase chưa bật, dữ liệu mới chỉ lưu RAM.", settings: workingSettingsCache });
        }
        const saved = await supabaseRequest(`${WORKING_SETTINGS_TABLE}?on_conflict=setting_key`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(payload)
        });
        await loadWorkingSettingsFromSupabase();
        res.json({ success: true, settings: currentWorkingSettings(), saved });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/supabase-migration-4-2-ad-mapping-sql', (req, res) => {
    res.type('text/plain').send(`create table if not exists ad_mappings (
    id uuid primary key default gen_random_uuid(),
    ad_account_id text,
    campaign_id text,
    campaign_name text,
    adset_id text,
    adset_name text,
    ad_id text unique not null,
    ad_name text,
    effective_status text,
    product_group text default 'unknown',
    product_item_key text,
    slide_key text,
    drive_folder text,
    image_urls jsonb default '[]'::jsonb,
    notes text,
    is_active boolean default true,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);
alter table ad_mappings add column if not exists product_item_key text;
create index if not exists idx_ad_mappings_ad_id on ad_mappings(ad_id);
create index if not exists idx_ad_mappings_campaign_id on ad_mappings(campaign_id);
create index if not exists idx_ad_mappings_adset_id on ad_mappings(adset_id);
create index if not exists idx_ad_mappings_product_group on ad_mappings(product_group);
create index if not exists idx_ad_mappings_product_item_key on ad_mappings(product_item_key);
create index if not exists idx_ad_mappings_active on ad_mappings(is_active);

create table if not exists product_items (
    id uuid primary key default gen_random_uuid(),
    product_group text not null,
    product_item_key text unique not null,
    product_item_name text not null,
    drive_folder text not null,
    aliases text,
    welcome_order int default 999,
    images_per_welcome int default 3,
    notes text,
    is_active boolean default true,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);
create index if not exists idx_product_items_group on product_items(product_group);
create index if not exists idx_product_items_active on product_items(is_active);

create table if not exists bot_working_settings (
    id uuid primary key default gen_random_uuid(),
    setting_key text unique not null default 'default',
    timezone text not null default 'Asia/Ho_Chi_Minh',
    work_start time not null default '08:00',
    work_end time not null default '22:00',
    is_open boolean not null default true,
    holiday_mode boolean not null default false,
    staff_online_count int default 1,
    admin_pause_minutes int not null default 10,
    customer_wait_minutes int not null default 5,
    outside_wait_minutes int not null default 5,
    carousel_cooldown_minutes int not null default 5,
    note text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);
insert into bot_working_settings(setting_key) values ('default') on conflict(setting_key) do nothing;

alter table messages add column if not exists customer_name text;
alter table messages add column if not exists ad_name text;
alter table messages add column if not exists campaign_name text;
alter table messages add column if not exists adset_name text;
alter table messages add column if not exists carousel_key text;
alter table messages add column if not exists drive_folder text;
alter table messages add column if not exists fallback_reason text;
alter table messages add column if not exists product_item_key text;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_ad_mappings_updated_at on ad_mappings;
create trigger trg_ad_mappings_updated_at before update on ad_mappings for each row execute function set_updated_at();
drop trigger if exists trg_product_items_updated_at on product_items;
create trigger trg_product_items_updated_at before update on product_items for each row execute function set_updated_at();
drop trigger if exists trg_bot_working_settings_updated_at on bot_working_settings;
create trigger trg_bot_working_settings_updated_at before update on bot_working_settings for each row execute function set_updated_at();
`);
});

app.get('/supabase-migration-4-1-1-sql', (req, res) => {
    res.type('text/plain').send(`alter table customers add column if not exists zalo_phone text;
alter table customers add column if not exists has_zalo boolean;
alter table customers add column if not exists contact_preference text;
alter table customers add column if not exists zalo_qr_provided boolean default false;
alter table messages add column if not exists source text;
alter table messages add column if not exists external_message_id text;
create index if not exists idx_messages_sender_created on messages(sender_id, created_at);
create index if not exists idx_messages_role on messages(role);
create index if not exists idx_messages_product_group on messages(product_group);
create index if not exists idx_conversations_session_key on conversations(session_key);
`);
});

app.get('/pancake-report', async (req, res) => {
    try {
        const limit = req.query.limit || 300;
        const conversations = await pancakeFetchConversations(limit);
        const report = conversations.map(pancakeBuildCustomerRow);

        const summary = {
            total: report.length,
            has_phone: report.filter(x => x.has_phone).length,
            no_phone: report.filter(x => !x.has_phone).length,
            hot_no_phone: report.filter(x => x.hot_lead && !x.has_phone).length,
            called: report.filter(x => x.tags.includes("Đã Gọi")).length,
            zalo: report.filter(x => x.tags.includes("Zalo")).length,
            not_buy: report.filter(x => x.tags.includes("k mua")).length,
            by_product: {
                quat: report.filter(x => x.product === "Quạt").length,
                thiet_bi_ve_sinh: report.filter(x => x.product === "Thiết bị vệ sinh").length,
                combo_phong_tam: report.filter(x => x.product === "Combo phòng tắm").length,
                bep: report.filter(x => x.product === "Bếp").length,
                bon_tam: report.filter(x => x.product === "Bồn tắm").length,
                khac: report.filter(x => x.product === "Khác").length
            }
        };

        res.json({
            success: true,
            page_id: PANCAKE_PAGE_ID,
            summary,
            hot_no_phone_customers: report.filter(x => x.hot_lead && !x.has_phone),
            customers_with_phone: report.filter(x => x.has_phone),
            customers_no_phone: report.filter(x => !x.has_phone),
            all_customers: report
        });
    } catch (error) {
        console.error("Pancake report error:", error);
        res.status(500).json({
            success: false,
            message: "Lỗi khi thống kê Pancake",
            error: error.message
        });
    }
});

app.get('/pancake-report-text', async (req, res) => {
    try {
        const limit = req.query.limit || 300;
        const conversations = await pancakeFetchConversations(limit);
        const report = conversations.map(pancakeBuildCustomerRow);

        const total = report.length;
        const hasPhone = report.filter(x => x.has_phone).length;
        const noPhone = report.filter(x => !x.has_phone).length;
        const hotNoPhone = report.filter(x => x.hot_lead && !x.has_phone);
        const called = report.filter(x => x.tags.includes("Đã Gọi")).length;
        const zalo = report.filter(x => x.tags.includes("Zalo")).length;
        const notBuy = report.filter(x => x.tags.includes("k mua")).length;

        const productLines = [
            `Quạt: ${report.filter(x => x.product === "Quạt").length}`,
            `Thiết bị vệ sinh: ${report.filter(x => x.product === "Thiết bị vệ sinh").length}`,
            `Combo phòng tắm: ${report.filter(x => x.product === "Combo phòng tắm").length}`,
            `Bếp: ${report.filter(x => x.product === "Bếp").length}`,
            `Bồn tắm: ${report.filter(x => x.product === "Bồn tắm").length}`,
            `Khác: ${report.filter(x => x.product === "Khác").length}`
        ];

        const hotLines = hotNoPhone.slice(0, 30).map((x, index) => {
            return `${index + 1}. ${x.name} | ${x.product} | ${x.updated_at}\n   Nội dung: ${x.snippet}\n   ID: ${x.conversation_id}`;
        });

        const phoneLines = report
            .filter(x => x.has_phone)
            .slice(0, 50)
            .map((x, index) => {
                return `${index + 1}. ${x.name} | ${x.phones.join(", ") || "Có số nhưng chưa đọc được số"} | ${x.product} | ${x.tags.join(", ") || "Chưa tag"}`;
            });

        res.type('text/plain').send(
`BÁO CÁO PANCAKE
Page ID: ${PANCAKE_PAGE_ID}
Số hội thoại lấy gần nhất: ${total}

TỔNG QUAN
- Có số điện thoại: ${hasPhone}
- Chưa có số điện thoại: ${noPhone}
- Khách nóng chưa có số: ${hotNoPhone.length}
- Đã gọi: ${called}
- Có tag Zalo: ${zalo}
- Không mua: ${notBuy}

PHÂN LOẠI SẢN PHẨM
${productLines.join("\n")}

KHÁCH NÓNG CHƯA CÓ SỐ
${hotLines.length ? hotLines.join("\n\n") : "Không có"}

KHÁCH ĐÃ CÓ SỐ
${phoneLines.length ? phoneLines.join("\n") : "Không có"}
`
        );
    } catch (error) {
        console.error("Pancake text report error:", error);
        res.status(500).type('text/plain').send(`Lỗi khi thống kê Pancake: ${error.message}`);
    }
});
app.get('/bot-history-keys', (req, res) => {
    const conversations = loadConversations();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(Object.keys(conversations).slice(0, 200).join("\n") || "Không có key nào");
});app.get('/history-debug', (req, res) => {
    const conversations = loadConversations();

    res.json({
        file: HISTORY_FILE,
        keys: Object.keys(conversations).length,
        sample: Object.keys(conversations).slice(0, 10)
    });
});
// ===== DEBUG PANCAKE =====
app.get('/pancake-debug', async (req, res) => {
    try {

        const url =
            `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversations` +
            `?page_access_token=${encodeURIComponent(PANCAKE_PAGE_ACCESS_TOKEN)}`;

        console.log("DEBUG URL:", url);

        const response = await fetch(url);

        const text = await response.text();

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(text);

    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});
app.get('/bot-history', (req, res) => {
    const id = req.query.id;
    let conversations = loadConversations();
    if (!id) return res.status(400).send("Thiếu id khách/PSID");

    const history = conversations[id] || [];

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(history.join("\n\n") || "Không có lịch sử trong server");
});
// ===== DÒ API CHI TIẾT 1 HỘI THOẠI PANCAKE =====
app.get('/pancake-conversation', async (req, res) => {
    try {
        const conversationId = req.query.id;

        if (!conversationId) {
            return res.status(400).send("Thiếu conversation id");
        }

        const token = encodeURIComponent(PANCAKE_PAGE_ACCESS_TOKEN);

        const urls = [
            `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversations/${encodeURIComponent(conversationId)}?page_access_token=${token}`,
            `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversations/${encodeURIComponent(conversationId)}/messages?page_access_token=${token}`,
            `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversation_messages?conversation_id=${encodeURIComponent(conversationId)}&page_access_token=${token}`,
            `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/messages?conversation_id=${encodeURIComponent(conversationId)}&page_access_token=${token}`
        ];

        let output = "";

        for (const url of urls) {
            try {
                const response = await fetch(url);
                const text = await response.text();

                output += `\n\n==============================\n`;
                output += `URL: ${url.replace(PANCAKE_PAGE_ACCESS_TOKEN, "***TOKEN***")}\n`;
                output += `STATUS: ${response.status}\n`;
                output += `CONTENT-TYPE: ${response.headers.get("content-type")}\n`;
                output += `BODY START:\n${text.slice(0, 3000)}\n`;
            } catch (err) {
                output += `\n\nURL ERROR: ${url}\n${err.message}\n`;
            }
        }

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(output);

    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});


// ===== PANCAKE REVIEW MODULE =====
// Endpoint dùng để rà chất lượng bot theo ngày, không fix cứng 25 hội thoại.
// Cách dùng:
// /pancake-review?limit=100&type=all
// /pancake-review?limit=200&type=hot
// /pancake-review?limit=200&type=no-phone
// /pancake-review?limit=200&type=phone
// /pancake-review?limit=200&type=zalo
// /pancake-review?limit=200&type=called
// /pancake-review?limit=200&type=no-called

function pancakeVietnamDateString(date = new Date()) {
    // Lấy ngày theo múi giờ Việt Nam để tránh Render chạy UTC làm lệch "hôm nay"
    const vn = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return vn.toISOString().slice(0, 10);
}

function pancakeConversationDateString(updatedAt) {
    if (!updatedAt) return "";
    const d = new Date(updatedAt);
    if (Number.isNaN(d.getTime())) {
        return String(updatedAt).slice(0, 10);
    }
    return pancakeVietnamDateString(d);
}

function pancakeReviewFilterRows(rows, type) {
    const t = String(type || "all").toLowerCase();

    if (t === "hot") {
        return rows.filter(x => x.hot_lead && !x.has_phone);
    }

    if (t === "no-phone" || t === "no_phone") {
        return rows.filter(x => !x.has_phone);
    }

    if (t === "phone" || t === "has-phone" || t === "has_phone") {
        return rows.filter(x => x.has_phone);
    }

    if (t === "zalo") {
        return rows.filter(x => x.tags.includes("Zalo"));
    }

    if (t === "called" || t === "da-goi" || t === "đã-gọi") {
        return rows.filter(x => x.tags.includes("Đã Gọi"));
    }

    if (t === "no-called" || t === "chua-goi" || t === "chưa-gọi") {
        return rows.filter(x => !x.tags.includes("Đã Gọi"));
    }

    return rows;
}

function pancakeReviewTypeLabel(type) {
    const t = String(type || "all").toLowerCase();

    if (t === "hot") return "Khách nóng chưa có số";
    if (t === "no-phone" || t === "no_phone") return "Khách chưa có số";
    if (t === "phone" || t === "has-phone" || t === "has_phone") return "Khách đã có số";
    if (t === "zalo") return "Khách có tag Zalo";
    if (t === "called" || t === "da-goi" || t === "đã-gọi") return "Khách đã gọi";
    if (t === "no-called" || t === "chua-goi" || t === "chưa-gọi") return "Khách chưa gọi";

    return "Tất cả hội thoại hôm nay";
}

app.get('/pancake-review', async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
        const type = String(req.query.type || "all").toLowerCase();
        const date = req.query.date ? String(req.query.date).slice(0, 10) : pancakeVietnamDateString();

        const conversations = await pancakeFetchConversations(limit);
        const report = conversations.map(pancakeBuildCustomerRow);

        const todayRows = report.filter(x => pancakeConversationDateString(x.updated_at) === date);
        const rows = pancakeReviewFilterRows(todayRows, type);

        const summary = {
            total_today: todayRows.length,
            showing: rows.length,
            has_phone: rows.filter(x => x.has_phone).length,
            no_phone: rows.filter(x => !x.has_phone).length,
            hot_no_phone: rows.filter(x => x.hot_lead && !x.has_phone).length,
            zalo: rows.filter(x => x.tags.includes("Zalo")).length,
            called: rows.filter(x => x.tags.includes("Đã Gọi")).length
        };

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');

        let text = "";
        text += `PANCAKE REVIEW BOT\n`;
        text += `Ngày: ${date}\n`;
        text += `Loại xem: ${pancakeReviewTypeLabel(type)}\n`;
        text += `Số hội thoại lấy gần nhất: ${limit}\n\n`;

        text += `TỔNG QUAN THEO BỘ LỌC\n`;
        text += `- Hội thoại hôm nay trong dữ liệu lấy về: ${summary.total_today}\n`;
        text += `- Đang hiển thị: ${summary.showing}\n`;
        text += `- Có số điện thoại: ${summary.has_phone}\n`;
        text += `- Chưa có số điện thoại: ${summary.no_phone}\n`;
        text += `- Khách nóng chưa có số: ${summary.hot_no_phone}\n`;
        text += `- Có tag Zalo: ${summary.zalo}\n`;
        text += `- Đã gọi: ${summary.called}\n\n`;

        text += `DANH SÁCH HỘI THOẠI\n`;

        if (rows.length === 0) {
            text += `Không có hội thoại phù hợp bộ lọc này.\n`;
        }

        rows.forEach((x, index) => {
            text += `\n${index + 1}. ${x.name} | ${x.product} | ${x.updated_at}\n`;
            text += `   ID: ${x.conversation_id}\n`;
            text += `   SĐT: ${x.phones.join(", ") || "Chưa có"}\n`;
            text += `   Tags: ${x.tags.join(", ") || "Không có"}\n`;
            text += `   Khách nóng: ${x.hot_lead ? "Có" : "Không"}\n`;
            text += `   Nội dung gần nhất: ${x.snippet || ""}\n`;
        });

        text += `\n\nGỢI Ý LINK NHANH\n`;
        text += `/pancake-review?limit=${limit}&type=all\n`;
        text += `/pancake-review?limit=${limit}&type=hot\n`;
        text += `/pancake-review?limit=${limit}&type=no-phone\n`;
        text += `/pancake-review?limit=${limit}&type=phone\n`;
        text += `/pancake-review?limit=${limit}&type=no-called\n`;

        res.send(text);
    } catch (error) {
        console.error("Pancake review error:", error);
        res.status(500).type('text/plain').send("Lỗi khi tạo Pancake review: " + error.message);
    }
});

// ===== DASHBOARD MODULE V2.2 =====
// Meta là nguồn chính cho bảng quảng cáo: chỉ hiện QC có chi tiêu trong khoảng thời gian đã chọn.
// Pancake chỉ dùng để map hội thoại/số điện thoại/tags vào các QC đang có spend.

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
// Có thể khai báo nhiều tài khoản bằng META_AD_ACCOUNT_IDS=act_xxx,act_yyy hoặc bật META_AUTO_AD_ACCOUNTS=true để lấy các tài khoản token truy cập được.
const META_AD_ACCOUNT_IDS = process.env.META_AD_ACCOUNT_IDS || process.env.META_AD_ACCOUNTS || "";
const META_AUTO_AD_ACCOUNTS = String(process.env.META_AUTO_AD_ACCOUNTS || "true").toLowerCase() !== "false";
const META_ACCOUNT_CARD_MAP = process.env.META_ACCOUNT_CARD_MAP || "";
// Múi giờ tài khoản quảng cáo. Tài khoản hiện reset khoảng 14h giờ Việt Nam nên mặc định dùng America/Los_Angeles.
// Có thể đổi trên Render nếu tài khoản Meta dùng múi giờ khác.
const META_ACCOUNT_TIMEZONE = process.env.META_ACCOUNT_TIMEZONE || "America/Los_Angeles";
const META_CARD_LAST4 = process.env.META_CARD_LAST4 || "";
// Best-effort: thử đọc phương thức thanh toán từ Meta account fields nếu token có quyền. Nếu API chặn thì tự bỏ qua.
const META_FETCH_BILLING_DETAILS = String(process.env.META_FETCH_BILLING_DETAILS || "true").toLowerCase() !== "false";
const PAYMENT_EVENTS_FILE = path.join(__dirname, "..", "payment_events.json");
// Nếu muốn dashboard cộng thêm thuế theo hệ số riêng, đặt ví dụ 1.05 hoặc 1.10. Mặc định giữ nguyên số Meta trả về.
const META_SPEND_TAX_MULTIPLIER = Number(process.env.META_SPEND_TAX_MULTIPLIER || 1);

const DASHBOARD_PANCAKE_CACHE_TTL = 3 * 60 * 1000;
const DASHBOARD_META_CACHE_TTL = 5 * 60 * 1000;

const dashboardCache = {
    pancake: new Map(),
    meta: new Map(),
    metaDaily: new Map(),
    metaAccounts: null
};

function dashboardEscapeHtml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function dashboardDateKeyVN(dateInput) {
    const d = new Date(dateInput);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

function dashboardDateKeyInTimeZone(dateInput, timeZone) {
    const d = new Date(dateInput);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-CA", { timeZone });
}

function dashboardDateKeyMeta(dateInput) {
    return dashboardDateKeyInTimeZone(dateInput, META_ACCOUNT_TIMEZONE);
}

function dashboardTodayKeyInTimeZone(timeZone, offsetDays = 0) {
    const now = new Date();
    const localNow = new Date(now.toLocaleString("en-US", { timeZone }));
    localNow.setDate(localNow.getDate() + offsetDays);
    const y = localNow.getFullYear();
    const m = String(localNow.getMonth() + 1).padStart(2, "0");
    const d = String(localNow.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function dashboardTodayKeyMeta(offsetDays = 0) {
    return dashboardTodayKeyInTimeZone(META_ACCOUNT_TIMEZONE, offsetDays);
}

function dashboardMonthStartKeyMeta() {
    const today = dashboardTodayKeyMeta(0);
    return `${today.slice(0, 8)}01`;
}

function dashboardGetTimeBasis(req) {
    const value = String(req.query.time_basis || req.query.timeBasis || "pancake").toLowerCase();
    return value === "meta" ? "meta" : "pancake";
}

function dashboardTimeBasisLabel(basis) {
    return basis === "meta" ? `Giờ tài khoản quảng cáo (${META_ACCOUNT_TIMEZONE})` : "Giờ Pancake / Việt Nam";
}

function dashboardDateKeyByBasis(dateInput, basis) {
    return basis === "meta" ? dashboardDateKeyMeta(dateInput) : dashboardDateKeyVN(dateInput);
}

function dashboardAddDaysKey(dateKey, days) {
    const [y, m, d] = String(dateKey).split("-").map(Number);
    const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return dt.toISOString().slice(0, 10);
}

function dashboardDaysInMonthFromKey(dateKey) {
    const [y, m] = String(dateKey).split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dashboardTodayKeyVN(offsetDays = 0) {
    const now = new Date();
    const vnNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    vnNow.setDate(vnNow.getDate() + offsetDays);
    const y = vnNow.getFullYear();
    const m = String(vnNow.getMonth() + 1).padStart(2, "0");
    const d = String(vnNow.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function dashboardMoney(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num) || num <= 0) return "0 đ";
    return `${Math.round(num).toLocaleString("vi-VN")} đ`;
}

function dashboardCost(spend, count) {
    const s = Number(spend || 0);
    const c = Number(count || 0);
    if (!s || !c) return "--";
    return dashboardMoney(s / c);
}

function dashboardRate(part, total) {
    if (!total) return "0.0";
    return ((part / total) * 100).toFixed(1);
}

function dashboardSelected(value, current) {
    return String(value) === String(current) ? "selected" : "";
}

function dashboardNormalizeProduct(product = "all") {
    const value = String(product || "all").toLowerCase();
    const map = {
        all: "all",
        quat: "Quạt",
        fan: "Quạt",
        thiet_bi_ve_sinh: "Thiết bị vệ sinh",
        tbvs: "Thiết bị vệ sinh",
        combo: "Combo phòng tắm",
        combo_phong_tam: "Combo phòng tắm",
        bep: "Bếp",
        bon_tam: "Bồn tắm",
        khac: "Khác"
    };
    return map[value] || "all";
}

function dashboardProductParamFromName(name = "all") {
    const map = {
        "Quạt": "quat",
        "Thiết bị vệ sinh": "thiet_bi_ve_sinh",
        "Combo phòng tắm": "combo",
        "Bếp": "bep",
        "Bồn tắm": "bon_tam",
        "Khác": "khac"
    };
    return map[name] || "all";
}

function dashboardGetViewValue(req, mode) {
    if (mode === "today") return "today";
    if (mode === "yesterday") return "yesterday";
    if (mode === "hot") return "hot";
    if (req.query.preset) return String(req.query.preset);
    if (req.query.hours) return `hours:${req.query.hours}`;
    if (req.query.date) return "date";
    return "all";
}

function dashboardFormatTags(tags = []) {
    return Array.isArray(tags) && tags.length ? tags.join(", ") : "Chưa tag";
}

const DASHBOARD_STAFF_TAGS = ["Sơn", "Phương", "Nhung"];

function dashboardAddCounts(target, names = []) {
    for (const name of names || []) {
        if (!name) continue;
        target[name] = (target[name] || 0) + 1;
    }
}

function dashboardCountSummary(obj = {}, limit = 6) {
    const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return "--";
    return entries.slice(0, limit).map(([name, count]) => `${name}(${count})`).join(", ");
}

function dashboardProductSummary(productCount) {
    return Object.entries(productCount || {})
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}: ${count}`)
        .join(", ") || "Chưa rõ";
}

function dashboardGetMetaDateRange(req, mode = "all") {
    const preset = String(req.query.preset || "").toLowerCase();
    const basis = dashboardGetTimeBasis(req);
    const todayFn = basis === "meta" ? dashboardTodayKeyMeta : dashboardTodayKeyVN;

    if (req.query.since && req.query.until) {
        return { since: String(req.query.since), until: String(req.query.until), label: `${req.query.since} → ${req.query.until}`, basis };
    }

    if (req.query.date) {
        return { since: String(req.query.date), until: String(req.query.date), label: String(req.query.date), basis };
    }

    if (preset === "last_7d") {
        return { since: todayFn(-6), until: todayFn(0), label: "7 ngày gần nhất", basis };
    }

    if (preset === "last_30d") {
        return { since: todayFn(-29), until: todayFn(0), label: "30 ngày gần nhất", basis };
    }

    if (mode === "yesterday") {
        const d = todayFn(-1);
        return { since: d, until: d, label: d, basis };
    }

    const today = todayFn(0);
    return { since: today, until: today, label: today, basis };
}

function dashboardFilterReport(report, req, mode = "all") {
    const dateRange = dashboardGetMetaDateRange(req, mode);
    let title = `Khoảng ${dateRange.label}`;
    let filtered = report.filter(x => {
        const key = dashboardDateKeyByBasis(x.updated_at || x.inserted_at || "", dateRange.basis);
        return key && key >= dateRange.since && key <= dateRange.until;
    });

    if (req.query.hours) {
        const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
        const fromTime = Date.now() - hours * 60 * 60 * 1000;
        title = `${hours} giờ gần nhất`;
        filtered = report.filter(x => {
            const t = new Date(x.updated_at).getTime();
            return !Number.isNaN(t) && t >= fromTime;
        });
    }

    const productName = dashboardNormalizeProduct(req.query.product || "all");
    if (productName !== "all") {
        title += ` | ${productName}`;
        filtered = filtered.filter(x => x.product === productName);
    }

    if (mode === "hot") {
        title = `Khách nóng chưa có số | ${title}`;
        filtered = filtered.filter(x => x.hot_lead && !x.has_phone);
    }

    return { title, report: filtered, productName, dateRange };
}

function dashboardBuildStats(report) {
    const total = report.length;
    const hasPhone = report.filter(x => x.has_phone).length;
    const noPhone = report.filter(x => !x.has_phone).length;
    const hotNoPhone = report.filter(x => x.hot_lead && !x.has_phone);
    const called = report.filter(x => x.tags.includes("Đã Gọi")).length;
    const zalo = report.filter(x => x.tags.includes("Zalo")).length;
    const phoneRate = total ? ((hasPhone / total) * 100).toFixed(1) : "0.0";
    const productCount = {
        quat: report.filter(x => x.product === "Quạt").length,
        thietBiVeSinh: report.filter(x => x.product === "Thiết bị vệ sinh").length,
        comboPhongTam: report.filter(x => x.product === "Combo phòng tắm").length,
        bep: report.filter(x => x.product === "Bếp").length,
        bonTam: report.filter(x => x.product === "Bồn tắm").length,
        khac: report.filter(x => x.product === "Khác").length
    };
    return { total, hasPhone, noPhone, hotNoPhone, called, zalo, phoneRate, productCount };
}

async function dashboardFetchPancakeCached(limit) {
    const key = `limit:${limit}`;
    const cached = dashboardCache.pancake.get(key);
    const now = Date.now();
    if (cached && now - cached.time < DASHBOARD_PANCAKE_CACHE_TTL) {
        return { conversations: cached.data, fetchedAt: cached.time, fromCache: true };
    }
    try {
        const conversations = await pancakeFetchConversations(limit);
        dashboardCache.pancake.set(key, { time: now, data: conversations });
        return { conversations, fetchedAt: now, fromCache: false };
    } catch (error) {
        console.error("Pancake API fallback to cache/internal:", error.message);
        if (cached) return { conversations: cached.data, fetchedAt: cached.time, fromCache: true, error: error.message };
        return { conversations: [], fetchedAt: null, fromCache: false, error: error.message };
    }
}

async function dashboardFetchJson(url) {
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
        throw new Error(data?.error?.message || `Meta API lỗi HTTP ${response.status}`);
    }
    return data;
}

// Đọc số lượt bắt đầu hội thoại từ Meta Insights.
// Meta có thể trả nhiều action_type khác nhau tùy mục tiêu quảng cáo/cột trong Ads Manager.
// Ưu tiên các action_type đúng về Messenger trước, rồi mới fallback sang các action có chữ messaging/message.
function dashboardExtractMetaMessagingCount(item = {}) {
    const actions = Array.isArray(item.actions) ? item.actions : [];
    if (!actions.length) return 0;

    const getVal = (a) => Number(a?.value || 0) || 0;
    const exactPriority = [
        "onsite_conversion.messaging_conversation_started_7d",
        "onsite_conversion.messaging_conversation_started",
        "messaging_conversation_started_7d",
        "messaging_conversation_started",
        "onsite_conversion.messaging_first_reply",
        "onsite_conversion.messaging_user_subscribed",
        "lead"
    ];

    for (const type of exactPriority) {
        const found = actions.find(a => String(a.action_type || "").toLowerCase() === type);
        if (found) return getVal(found);
    }

    const flexible = actions.filter(a => {
        const t = String(a.action_type || "").toLowerCase();
        return (t.includes("messaging") || t.includes("messenger"))
            && (t.includes("conversation") || t.includes("reply") || t.includes("started") || t.includes("message"));
    });
    if (flexible.length) return flexible.reduce((sum, a) => sum + getVal(a), 0);

    return 0;
}


function dashboardNormalizeActId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.startsWith("act_") ? raw : `act_${raw}`;
}

function dashboardParseAccountList(value = "") {
    const raw = String(value || "").trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(x => typeof x === "string" ? { id: x } : x).filter(Boolean);
        if (parsed && typeof parsed === "object") {
            return Object.entries(parsed).map(([id, info]) => ({ id, ...(typeof info === "object" ? info : { name: String(info || id) }) }));
        }
    } catch (_) {}
    return raw.split(/[;,\n]+/).map(x => x.trim()).filter(Boolean).map(id => ({ id }));
}

function dashboardParseAccountCardMap() {
    const map = {};
    const raw = String(META_ACCOUNT_CARD_MAP || "").trim();
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            for (const [id, value] of Object.entries(parsed || {})) {
                const act = dashboardNormalizeActId(id);
                map[act] = typeof value === "object" ? String(value.card || value.last4 || "") : String(value || "");
            }
        } catch (_) {
            for (const part of raw.split(/[;,\n]+/)) {
                const [id, card] = part.split(/[=:]/).map(x => String(x || "").trim());
                if (id && card) map[dashboardNormalizeActId(id)] = card;
            }
        }
    }
    if (META_CARD_LAST4 && META_AD_ACCOUNT_ID) map[dashboardNormalizeActId(META_AD_ACCOUNT_ID)] = META_CARD_LAST4;
    return map;
}

function dashboardExtractCardLast4(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value || "");
    const patterns = [
        /(?:Visa|Mastercard|MasterCard|card|thẻ|the)\D{0,30}(?:\*{2,}|x{2,}|…|\.{2,}|-)?\s*(\d{4})/i,
        /(?:last4|last_4|last_four|card_last4)\D{0,20}(\d{4})/i,
        /(?:\*{2,}|x{2,}|…|\.{2,})\s*(\d{4})/i
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m && m[1]) return m[1];
    }
    return "";
}

async function dashboardHydrateAccountBillingDetails(accounts = []) {
    if (!META_FETCH_BILLING_DETAILS || !META_ACCESS_TOKEN || !Array.isArray(accounts) || !accounts.length) return accounts;
    const token = encodeURIComponent(META_ACCESS_TOKEN);
    const out = [];
    for (const acc of accounts) {
        const id = dashboardNormalizeActId(acc.id || acc.accountId || "");
        if (!id || acc.cardLast4) { out.push(acc); continue; }
        try {
            // Một số token/account trả funding_source_details, một số sẽ bị Meta chặn. Lỗi ở đây không được làm hỏng dashboard.
            const url = `https://graph.facebook.com/v23.0/${id}?fields=id,name,account_id,funding_source,funding_source_details&access_token=${token}`;
            const data = await dashboardFetchJson(url);
            const cardLast4 = dashboardExtractCardLast4(data.funding_source_details || data.funding_source || data);
            out.push({
                ...acc,
                name: acc.name && acc.name !== id ? acc.name : (data.name || acc.name || id),
                cardLast4: cardLast4 || acc.cardLast4 || "",
                fundingSourceReadable: cardLast4 ? `Visa/Mastercard ...${cardLast4}` : "",
                billingRead: true
            });
        } catch (error) {
            out.push({ ...acc, billingRead: false, billingError: error.message });
        }
    }
    return out;
}

async function dashboardFetchGraphPages(url, maxPages = 20) {
    const rows = [];
    let nextUrl = url;
    let pages = 0;
    while (nextUrl && pages < maxPages) {
        const data = await dashboardFetchJson(nextUrl);
        if (Array.isArray(data.data)) rows.push(...data.data);
        nextUrl = data?.paging?.next || "";
        pages++;
    }
    return rows;
}

async function dashboardGetMetaAccounts() {
    const now = Date.now();
    if (dashboardCache.metaAccounts && now - dashboardCache.metaAccounts.time < 15 * 60 * 1000) {
        return dashboardCache.metaAccounts.data;
    }

    const map = new Map();
    const configured = dashboardParseAccountList(META_AD_ACCOUNT_IDS || META_AD_ACCOUNT_ID);
    for (const x of configured) {
        const id = dashboardNormalizeActId(x.id || x.account_id || x.act || x);
        if (!id) continue;
        map.set(id, { id, name: x.name || x.accountName || id, cardLast4: x.card || x.cardLast4 || x.last4 || "", source: "env" });
    }

    // Từ 3.7.1: luôn GỘP tài khoản khai báo thủ công với tài khoản token có quyền đọc.
    // Trước đó nếu META_AD_ACCOUNT_ID tồn tại thì auto discovery bị bỏ qua, nên dashboard chỉ thấy 1 tài khoản.
    if (META_AUTO_AD_ACCOUNTS && META_ACCESS_TOKEN) {
        const token = encodeURIComponent(META_ACCESS_TOKEN);
        const errors = [];
        const addAccounts = (items = [], source = "auto") => {
            for (const x of items || []) {
                const id = dashboardNormalizeActId(x.id || x.account_id || x.accountId || "");
                if (!id) continue;
                const old = map.get(id) || {};
                map.set(id, {
                    ...old,
                    id,
                    name: old.name && old.name !== id ? old.name : (x.name || x.account_name || id),
                    status: x.account_status || x.status || old.status,
                    source: old.source ? `${old.source}+${source}` : source,
                    cardLast4: old.cardLast4 || x.cardLast4 || x.card || x.last4 || ""
                });
            }
        };

        try {
            const directUrl = `https://graph.facebook.com/v23.0/me/adaccounts?fields=id,name,account_status&limit=200&access_token=${token}`;
            addAccounts(await dashboardFetchGraphPages(directUrl), "me/adaccounts");
        } catch (error) {
            errors.push(`me/adaccounts: ${error.message}`);
        }

        try {
            const businessUrl = `https://graph.facebook.com/v23.0/me/businesses?fields=id,name&limit=100&access_token=${token}`;
            const businesses = await dashboardFetchGraphPages(businessUrl);
            for (const biz of businesses || []) {
                const bizId = biz.id;
                if (!bizId) continue;
                try {
                    const ownedUrl = `https://graph.facebook.com/v23.0/${bizId}/owned_ad_accounts?fields=id,name,account_status&limit=200&access_token=${token}`;
                    addAccounts(await dashboardFetchGraphPages(ownedUrl), `owned:${biz.name || bizId}`);
                } catch (error) {
                    errors.push(`owned ${biz.name || bizId}: ${error.message}`);
                }
                try {
                    const clientUrl = `https://graph.facebook.com/v23.0/${bizId}/client_ad_accounts?fields=id,name,account_status&limit=200&access_token=${token}`;
                    addAccounts(await dashboardFetchGraphPages(clientUrl), `client:${biz.name || bizId}`);
                } catch (error) {
                    errors.push(`client ${biz.name || bizId}: ${error.message}`);
                }
            }
        } catch (error) {
            errors.push(`me/businesses: ${error.message}`);
        }
        if (errors.length) console.warn("Meta account discovery warnings:", errors.join(" | "));
    }

    let accounts = Array.from(map.values()).filter(x => x.id);
    accounts = await dashboardHydrateAccountBillingDetails(accounts);
    dashboardCache.metaAccounts = { time: now, data: accounts };
    return accounts;
}

function dashboardAccountLabel(account = {}) {
    const id = dashboardNormalizeActId(account.id || account.accountId || "");
    const name = account.name && account.name !== id ? `${account.name} ` : "";
    return `${name}${id}`.trim();
}

function dashboardLoadPaymentEvents() {
    try {
        if (!fs.existsSync(PAYMENT_EVENTS_FILE)) return [];
        const raw = fs.readFileSync(PAYMENT_EVENTS_FILE, "utf8").trim();
        if (!raw) return [];
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error("Load payment events error:", error);
        return [];
    }
}

function dashboardSavePaymentEvents(events) {
    try {
        fs.writeFileSync(PAYMENT_EVENTS_FILE, JSON.stringify(events.slice(-500), null, 2));
    } catch (error) {
        console.error("Save payment events error:", error);
    }
}

function dashboardParsePaymentText(text = "", accountId = "") {
    const input = String(text || "");
    const cardMatch = input.match(/(?:Visa|Mastercard|Thẻ|Thẻ|card)?[^0-9]*(?:\d{4,6})?\D*(?:\.\.\.|\*{2,}|x{2,})\s*(\d{4})/i) || input.match(/(?:last4|card|visa)\D*(\d{4})/i);
    const amountMatch = input.replace(/,/g, ".").match(/(\d{1,3}(?:[\.\s]\d{3})+|\d+)\s*(?:VND|đ|VNĐ)/i);
    const dateTimeMatch = input.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    const cardLast4 = cardMatch ? cardMatch[1] : "";
    let amount = 0;
    if (amountMatch) amount = Number(String(amountMatch[1]).replace(/[^0-9]/g, "")) || 0;
    let occurredAt = new Date().toISOString();
    if (dateTimeMatch) {
        const [, dd, mm, yyyy, hh = "00", min = "00", ss = "00"] = dateTimeMatch;
        occurredAt = new Date(`${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}T${String(hh).padStart(2,"0")}:${min}:${ss}+07:00`).toISOString();
    }
    return { cardLast4, amount, accountId: dashboardNormalizeActId(accountId), occurredAt, rawText: input, createdAt: new Date().toISOString() };
}

function dashboardPaymentCardForDate(dateKey, accountId = "") {
    const events = dashboardLoadPaymentEvents();
    const targetTs = new Date(`${dateKey}T23:59:59Z`).getTime();
    const normalizedAccount = dashboardNormalizeActId(accountId);
    const relevant = events
        .filter(e => e.cardLast4 && (!normalizedAccount || !e.accountId || e.accountId === normalizedAccount))
        .map(e => ({ ...e, ts: new Date(e.occurredAt || e.createdAt || 0).getTime() }))
        .filter(e => !Number.isNaN(e.ts) && e.ts <= targetTs)
        .sort((a, b) => b.ts - a.ts);
    return relevant[0]?.cardLast4 || "";
}

async function dashboardFetchMetaAdsCached(dateRange) {
    const result = {
        enabled: Boolean(META_ACCESS_TOKEN && (META_AD_ACCOUNT_ID || META_AD_ACCOUNT_IDS || META_AUTO_AD_ACCOUNTS)),
        error: null,
        fetchedAt: Date.now(),
        fromCache: false,
        ads: [],
        byId: {},
        accounts: [],
        totalSpend: 0,
        rawTotalSpend: 0,
        dateRange
    };

    if (!result.enabled) {
        result.error = "Thiếu META_ACCESS_TOKEN hoặc META_AD_ACCOUNT_ID/META_AD_ACCOUNT_IDS";
        return result;
    }

    let accounts = [];
    try {
        accounts = await dashboardGetMetaAccounts();
    } catch (error) {
        result.error = `Không lấy được danh sách tài khoản QC: ${error.message}`;
        return result;
    }
    if (!accounts.length) {
        result.error = "Không có tài khoản quảng cáo nào để đọc. Hãy đặt META_AD_ACCOUNT_ID, META_AD_ACCOUNT_IDS hoặc META_AUTO_AD_ACCOUNTS=true";
        return result;
    }

    const accountCardMap = dashboardParseAccountCardMap();
    const accountKey = accounts.map(a => dashboardNormalizeActId(a.id)).join(",");
    const key = `${accountKey}:${dateRange.since}:${dateRange.until}:multi-spend-positive-actions-3-9-1:${META_SPEND_TAX_MULTIPLIER}`;
    const cached = dashboardCache.meta.get(key);
    const now = Date.now();
    if (cached && now - cached.time < DASHBOARD_META_CACHE_TTL) {
        return { ...cached.data, fetchedAt: cached.time, fromCache: true };
    }

    const token = encodeURIComponent(META_ACCESS_TOKEN);
    const range = encodeURIComponent(JSON.stringify({ since: dateRange.since, until: dateRange.until }));
    const byId = {};
    let rawTotalSpend = 0;
    const errors = [];

    for (const accountInfo of accounts) {
        const account = dashboardNormalizeActId(accountInfo.id);
        if (!account) continue;
        const accountName = accountInfo.name || account;
        const cardLast4 = String(accountInfo.cardLast4 || accountCardMap[account] || META_CARD_LAST4 || "");
        try {
            const adsUrl = `https://graph.facebook.com/v23.0/${account}/ads?fields=id,name,status,effective_status,configured_status,campaign{id,name},adset{id,name}&limit=500&access_token=${token}`;
            const insightsUrl = `https://graph.facebook.com/v23.0/${account}/insights?level=ad&fields=ad_id,ad_name,spend,impressions,clicks,reach,cpc,cpm,ctr,actions&time_range=${range}&limit=500&access_token=${token}`;

            const [adsData, insightsData] = await Promise.all([
                dashboardFetchJson(adsUrl),
                dashboardFetchJson(insightsUrl)
            ]);

            const metaInfoById = {};
            for (const ad of adsData.data || []) {
                metaInfoById[String(ad.id)] = {
                    adId: String(ad.id),
                    name: ad.name || `QC ${ad.id}`,
                    status: ad.effective_status || ad.configured_status || ad.status || "UNKNOWN",
                    campaignName: ad.campaign?.name || "",
                    adsetName: ad.adset?.name || ""
                };
            }

            let accountSpend = 0;
            for (const item of insightsData.data || []) {
                const id = String(item.ad_id || "");
                if (!id) continue;

                const rawSpend = Number(item.spend || 0);
                const spend = rawSpend * (Number.isFinite(META_SPEND_TAX_MULTIPLIER) && META_SPEND_TAX_MULTIPLIER > 0 ? META_SPEND_TAX_MULTIPLIER : 1);
                rawTotalSpend += spend;
                accountSpend += spend;
                if (spend <= 0) continue;

                const info = metaInfoById[id] || {};
                const keyId = `${account}:${id}`;
                byId[keyId] = {
                    adId: id,
                    accountId: account,
                    accountName,
                    accountLabel: dashboardAccountLabel({ id: account, name: accountName }),
                    cardLast4,
                    name: item.ad_name || info.name || `QC ${id}`,
                    status: info.status || "UNKNOWN",
                    campaignName: info.campaignName || "",
                    adsetName: info.adsetName || "",
                    spend,
                    impressions: Number(item.impressions || 0),
                    clicks: Number(item.clicks || 0),
                    reach: Number(item.reach || 0),
                    cpc: Number(item.cpc || 0),
                    cpm: Number(item.cpm || 0),
                    ctr: Number(item.ctr || 0),
                    messagingCount: dashboardExtractMetaMessagingCount(item)
                };
            }

            result.accounts.push({ id: account, name: accountName, spend: accountSpend, cardLast4 });
        } catch (error) {
            console.error("Meta Ads dashboard account error:", account, error);
            errors.push(`${account}: ${error.message}`);
            result.accounts.push({ id: account, name: accountName, spend: 0, cardLast4, paymentMethod: cardLast4 ? `Visa ...${cardLast4}` : (accountInfo.fundingSourceReadable || accountInfo.paymentMethod || "Trả trước/không thẻ"), error: error.message });
        }
    }

    result.byId = byId;
    result.ads = Object.values(byId).sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
    result.rawTotalSpend = rawTotalSpend;
    result.totalSpend = result.ads.reduce((sum, x) => sum + Number(x.spend || 0), 0);
    if (errors.length) result.error = errors.join(" | ");
    dashboardCache.meta.set(key, { time: now, data: result });
    return result;
}

async function dashboardFetchMetaDailyCached(dateRange) {
    const result = {
        enabled: Boolean(META_ACCESS_TOKEN && (META_AD_ACCOUNT_ID || META_AD_ACCOUNT_IDS || META_AUTO_AD_ACCOUNTS)),
        error: null,
        fetchedAt: Date.now(),
        fromCache: false,
        rows: [],
        byDate: {},
        accountByDate: {},
        messageByDate: {},
        accounts: [],
        totalSpend: 0,
        totalMessages: 0,
        dateRange
    };

    if (!result.enabled) {
        result.error = "Thiếu META_ACCESS_TOKEN hoặc META_AD_ACCOUNT_ID/META_AD_ACCOUNT_IDS";
        return result;
    }

    let accounts = [];
    try {
        accounts = await dashboardGetMetaAccounts();
    } catch (error) {
        result.error = `Không lấy được danh sách tài khoản QC: ${error.message}`;
        return result;
    }
    if (!accounts.length) {
        result.error = "Không có tài khoản quảng cáo nào để đọc.";
        return result;
    }

    const accountCardMap = dashboardParseAccountCardMap();
    const accountKey = accounts.map(a => dashboardNormalizeActId(a.id)).join(",");
    const key = `${accountKey}:daily:${dateRange.since}:${dateRange.until}:${META_SPEND_TAX_MULTIPLIER}:actions-v2`;
    const cached = dashboardCache.metaDaily.get(key);
    const now = Date.now();
    if (cached && now - cached.time < DASHBOARD_META_CACHE_TTL) {
        return { ...cached.data, fetchedAt: cached.time, fromCache: true };
    }

    const token = encodeURIComponent(META_ACCESS_TOKEN);
    const range = encodeURIComponent(JSON.stringify({ since: dateRange.since, until: dateRange.until }));
    const byDate = {};
    const accountByDate = {};
    const errors = [];

    for (const accountInfo of accounts) {
        const account = dashboardNormalizeActId(accountInfo.id);
        if (!account) continue;
        const accountName = accountInfo.name || account;
        const cardLast4 = String(accountInfo.cardLast4 || accountCardMap[account] || META_CARD_LAST4 || "");
        try {
            const url = `https://graph.facebook.com/v23.0/${account}/insights?fields=spend,date_start,date_stop,actions&time_increment=1&time_range=${range}&limit=500&access_token=${token}`;
            const data = await dashboardFetchJson(url);
            let accountTotal = 0;
            for (const item of data.data || []) {
                const day = String(item.date_start || "");
                if (!day) continue;
                const rawSpend = Number(item.spend || 0);
                const spend = rawSpend * (Number.isFinite(META_SPEND_TAX_MULTIPLIER) && META_SPEND_TAX_MULTIPLIER > 0 ? META_SPEND_TAX_MULTIPLIER : 1);
                const messageCount = dashboardExtractMetaMessagingCount(item);
                byDate[day] = (byDate[day] || 0) + spend;
                result.messageByDate[day] = (result.messageByDate[day] || 0) + messageCount;
                result.totalMessages += messageCount;
                if (!accountByDate[day]) accountByDate[day] = [];
                accountByDate[day].push({
                    accountId: account,
                    accountName,
                    accountLabel: dashboardAccountLabel({ id: account, name: accountName }),
                    spend,
                    messageCount,
                    cardLast4,
                    paymentMethod: cardLast4 ? `Visa ...${cardLast4}` : (accountInfo.fundingSourceReadable || accountInfo.paymentMethod || "Trả trước/không thẻ")
                });
                accountTotal += spend;
            }
            result.accounts.push({ id: account, name: accountName, spend: accountTotal, cardLast4, paymentMethod: cardLast4 ? `Visa ...${cardLast4}` : (accountInfo.fundingSourceReadable || accountInfo.paymentMethod || "Trả trước/không thẻ") });
        } catch (error) {
            console.error("Meta daily dashboard account error:", account, error);
            errors.push(`${account}: ${error.message}`);
            result.accounts.push({ id: account, name: accountName, spend: 0, cardLast4, paymentMethod: cardLast4 ? `Visa ...${cardLast4}` : (accountInfo.fundingSourceReadable || accountInfo.paymentMethod || "Trả trước/không thẻ"), error: error.message });
        }
    }

    result.byDate = byDate;
    result.accountByDate = accountByDate;
    result.rows = Object.entries(byDate).map(([date, spend]) => ({ date, spend, accounts: accountByDate[date] || [] })).sort((a, b) => a.date.localeCompare(b.date));
    result.totalSpend = result.rows.reduce((sum, x) => sum + Number(x.spend || 0), 0);
    if (errors.length) result.error = errors.join(" | ");
    dashboardCache.metaDaily.set(key, { time: now, data: result });
    return result;
}

function dashboardFormatAccountSpendList(accounts = []) {
    const active = (accounts || []).filter(x => Number(x.spend || 0) > 0);
    if (!active.length) return "";
    return active
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
        .map(x => `${x.accountName || x.name || x.accountId || x.id || "Tài khoản QC"}: ${dashboardMoney(x.spend)}`)
        .join(" | ");
}

function dashboardFormatAccountNamesHtml(accounts = []) {
    const active = (accounts || []).filter(x => Number(x.spend || 0) > 0);
    if (!active.length) return "";
    return active
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
        .map(x => {
            const name = dashboardEscapeHtml(x.accountName || x.name || "Tài khoản quảng cáo");
            const id = dashboardEscapeHtml(x.accountId || x.id || "");
            return `<div class="account-cell"><div class="account-name">${name}</div>${id ? `<div class="account-id">${id}</div>` : ""}</div>`;
        })
        .join("");
}

function dashboardFormatAccountSpendHtml(accounts = []) {
    const active = (accounts || []).filter(x => Number(x.spend || 0) > 0);
    if (!active.length) return "";
    return active
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
        .map(x => `<div class="account-spend"><b>${dashboardMoney(x.spend)}</b></div>`)
        .join("");
}

function dashboardCardsForDate(dateKey, accounts = []) {
    const methods = new Set();
    for (const acc of accounts || []) {
        const fromPayment = dashboardPaymentCardForDate(dateKey, acc.accountId || acc.id || "");
        const card = fromPayment || acc.cardLast4 || "";
        if (card) methods.add(card);
        else if (Number(acc.spend || 0) > 0) methods.add(acc.paymentMethod || "Trả trước/không thẻ");
    }
    if (!methods.size) {
        const fallbackPayment = dashboardPaymentCardForDate(dateKey, "");
        if (fallbackPayment) methods.add(fallbackPayment);
        else if (META_CARD_LAST4) methods.add(META_CARD_LAST4);
    }
    return Array.from(methods).join(", ");
}

function dashboardBuildInternalDailyStats(monthKey) {
    const targetMonth = String(monthKey || "").slice(0, 7);
    const byDate = {};
    const events = loadMessageEvents();
    for (const e of events) {
        if (e.direction && e.direction !== "customer") continue;
        const key = dashboardDateKeyMeta(e.created_at || e.timestamp || e.updated_at || "");
        if (!key || !key.startsWith(targetMonth)) continue;
        if (!byDate[key]) byDate[key] = { total: 0, phoneCustomers: new Set(), zaloCustomers: new Set(), phones: new Set() };
        byDate[key].total += 1;
        const customerKey = e.customer_key || `${e.page_id || ""}:${e.sender_id || ""}`;
        const phones = Array.isArray(e.phones) ? e.phones : extractPhonesFromText(e.text || "");
        if (e.has_phone || phones.length) {
            byDate[key].phoneCustomers.add(customerKey);
            phones.forEach(p => byDate[key].phones.add(p));
        }
        const hasZalo = e.has_zalo || detectZaloFromText(e.text || "") || (Array.isArray(e.tags) && e.tags.includes("Zalo"));
        if (hasZalo) byDate[key].zaloCustomers.add(customerKey);
    }
    const out = {};
    for (const [day, val] of Object.entries(byDate)) {
        out[day] = {
            total: val.total,
            hasPhone: val.phoneCustomers.size || val.phones.size,
            zalo: val.zaloCustomers.size
        };
    }
    return out;
}

function dashboardBuildPancakeDailyLeadStats(report = [], monthKey = "") {
    const targetMonth = String(monthKey || "").slice(0, 7);
    const out = {};
    for (const item of report || []) {
        const key = dashboardDateKeyMeta(item.updated_at || item.inserted_at || item.created_at || "");
        if (!key || !key.startsWith(targetMonth)) continue;
        if (!out[key]) out[key] = { total: 0, hasPhone: 0, zalo: 0 };
        out[key].total += 1;
        if (item.has_phone) out[key].hasPhone += 1;
        if ((item.tags || []).includes("Zalo") || item.has_zalo) out[key].zalo += 1;
    }
    return out;
}

function dashboardBuildMonthlyLeadRows(report, metaDaily, monthKey, source = "meta", pancakeReport = []) {
    const days = dashboardDaysInMonthFromKey(monthKey);
    const todayMeta = dashboardTodayKeyMeta(0);
    const currentDayNumber = Number(todayMeta.slice(8, 10));
    const targetMonth = monthKey.slice(0, 7);
    const lastDay = monthKey.slice(0, 7) === todayMeta.slice(0, 7) ? currentDayNumber : days;
    const byDate = {};
    const internalDaily = dashboardBuildInternalDailyStats(monthKey);
    const pancakeDaily = dashboardBuildPancakeDailyLeadStats(pancakeReport, monthKey);

    for (let i = 1; i <= days; i++) {
        const day = `${targetMonth}-${String(i).padStart(2, "0")}`;
        const accounts = metaDaily?.accountByDate?.[day] || [];
        const direct = internalDaily[day] || { total: 0, hasPhone: 0, zalo: 0 };
        const pancake = pancakeDaily[day] || { total: 0, hasPhone: 0, zalo: 0 };
        const metaMessages = Number(metaDaily?.messageByDate?.[day] || 0);
        // AIGUKA 3.9.5: Meta Direct phải khớp Ads Manager/báo cáo tháng.
        // Không lấy max(dữ liệu webhook/Pancake, Meta) vì webhook có thể nhiều hơn Meta
        // và sẽ làm lệch số tin nhắn hàng ngày.
        const totalMessages = source === "pancake"
            ? Number(pancake.total || 0)
            : metaMessages;
        byDate[day] = {
            date: day,
            spend: Number(metaDaily?.byDate?.[day] || 0),
            accountSpendText: dashboardFormatAccountSpendList(accounts),
            accounts,
            total: totalMessages,
            // SĐT/Zalo là dữ liệu bổ sung từ webhook/Pancake, nhưng KHÔNG làm tăng số hội thoại Meta.
            hasPhone: source === "pancake" ? Number(pancake.hasPhone || 0) : Math.max(Number(direct.hasPhone || 0), Number(pancake.hasPhone || 0)),
            zalo: source === "pancake" ? Number(pancake.zalo || 0) : Math.max(Number(direct.zalo || 0), Number(pancake.zalo || 0)),
            visa: dashboardCardsForDate(day, accounts)
        };
    }

    // Dữ liệu lead theo ngày đã được gộp ở trên: Meta Direct ưu tiên message_events/Meta Insights, Pancake chỉ dùng khi chọn Pancake hoặc để bù SĐT/Zalo lịch sử.

    const rows = [];
    for (let i = 1; i <= lastDay; i++) {
        const day = `${targetMonth}-${String(i).padStart(2, "0")}`;
        rows.push(byDate[day]);
    }

    const totalAccountMap = {};
    for (const row of rows) {
        for (const acc of row.accounts || []) {
            const id = acc.accountId || acc.id || "unknown";
            if (!totalAccountMap[id]) totalAccountMap[id] = { ...acc, spend: 0 };
            totalAccountMap[id].spend += Number(acc.spend || 0);
        }
    }

    const totalRow = rows.reduce((acc, x) => {
        acc.spend += Number(x.spend || 0);
        acc.total += Number(x.total || 0);
        acc.hasPhone += Number(x.hasPhone || 0);
        acc.zalo += Number(x.zalo || 0);
        return acc;
    }, { date: `Tổng tháng ${targetMonth}`, spend: 0, total: 0, hasPhone: 0, zalo: 0, visa: "", isTotal: true, accountSpendText: "" });
    totalRow.accountSpendText = dashboardFormatAccountSpendList(Object.values(totalAccountMap));
    totalRow.accounts = Object.values(totalAccountMap);
    totalRow.visa = dashboardCardsForDate(todayMeta, Object.values(totalAccountMap));

    return { rows, totalRow, days, lastDay, targetMonth };
}

function dashboardRenderMetaMonthHtml({ limit, fullTotal, report, pancakeReport = [], pancakeMeta, metaDaily, monthKey, dataSource = "meta" }) {
    const monthData = dashboardBuildMonthlyLeadRows(report, metaDaily, monthKey, dataSource, pancakeReport);
    const metaTime = metaDaily?.fetchedAt ? new Date(metaDaily.fetchedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : "Chưa có";
    const pancakeTime = pancakeMeta?.fetchedAt ? new Date(pancakeMeta.fetchedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : "Chưa có";
    const metaNotice = metaDaily?.error ? `<div class="notice red-note">Meta Ads: ${dashboardEscapeHtml(metaDaily.error)}</div>` : "";
    const rowHtml = [monthData.totalRow, ...monthData.rows].map((x, index) => `
        <tr class="${x.isTotal ? 'row-total' : ''}">
            <td>${x.isTotal ? '<b>Tổng</b>' : index}</td>
            <td><b>${dashboardEscapeHtml(x.date)}</b></td>
            <td><b>${dashboardMoney(x.spend)}</b></td>
            <td>${dashboardFormatAccountNamesHtml(x.accounts || [])}</td>
            <td>${dashboardFormatAccountSpendHtml(x.accounts || [])}</td>
            <td>${x.total}</td>
            <td><b>${x.hasPhone}</b><br><span>${dashboardRate(x.hasPhone, x.total)}%</span></td>
            <td>${x.zalo}</td>
            <td>${dashboardEscapeHtml(x.visa || '')}</td>
        </tr>
    `).join("");

    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Báo cáo tháng theo giờ Meta</title><style>
        body{margin:0;font-family:"Times New Roman",Times,serif;background:#f8fafc;color:#111827}.wrap{max-width:1280px;margin:0 auto;padding:18px}.header{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:16px}.header h1{margin:0;font-size:28px}.header p{margin:6px 0 0;color:#64748b}.btns a{display:inline-block;margin-left:8px;padding:10px 12px;border-radius:10px;background:#2563eb;color:white;text-decoration:none}.btns a.green{background:#16a34a}.filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;background:white;padding:14px;border-radius:16px;box-shadow:0 1px 4px rgba(15,23,42,.08);margin-bottom:14px;border:1px solid #e2e8f0}.filter label{display:block;font-size:13px;color:#64748b;margin-bottom:5px}.filter input,.filter select{width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #cbd5e1;background:#f8fafc;font-family:"Times New Roman",Times,serif}.notice{background:#fff7ed;border:1px solid #fed7aa;padding:12px;border-radius:12px;margin:12px 0;color:#9a3412}.red-note{background:#fef2f2;border-color:#fecaca;color:#991b1b}.table-wrap{overflow-x:auto;border-radius:16px;box-shadow:0 1px 4px rgba(15,23,42,.08);border:1px solid #e2e8f0}table{width:100%;border-collapse:collapse;background:white;min-width:1100px}th,td{padding:12px;border-bottom:1px solid #dbeafe;border-right:1px solid #cbd5e1;text-align:left;vertical-align:top}th:first-child,td:first-child{border-left:1px solid #cbd5e1}th{background:#dbeafe;border-bottom:2px solid #93c5fd;font-weight:800;position:sticky;top:0}td span{color:#64748b;font-size:13px}.account-cell{margin-bottom:8px}.account-name{font-size:16px;font-weight:800;color:#0f172a}.account-id{font-size:12px;color:#94a3b8;margin-top:2px}.account-spend{font-size:15px;margin-bottom:14px;min-height:28px}tbody tr:nth-child(even){background:#f8fafc}.row-total{background:#dcfce7!important;font-size:16px}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}.card{background:white;border-radius:16px;padding:16px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(15,23,42,.08)}.card .label{color:#475569}.card .num{font-size:28px;font-weight:800;margin-top:8px}@media(max-width:900px){.header{display:block}.btns{margin-top:12px}.btns a{margin:4px 4px 0 0}.filters,.summary{grid-template-columns:1fr}th,td{font-size:12px;padding:9px}}
    </style></head><body><div class="wrap"><div class="header"><div><h1>📅 Báo cáo tháng theo giờ tài khoản quảng cáo</h1><p>Tháng ${dashboardEscapeHtml(monthData.targetMonth)} | Múi giờ Meta: ${dashboardEscapeHtml(META_ACCOUNT_TIMEZONE)} | Reset khoảng 14h giờ VN nếu tài khoản dùng giờ Hoa Kỳ</p><p>Đã lấy ${fullTotal}/${limit} hội thoại Pancake | Pancake: ${dashboardEscapeHtml(pancakeTime)} ${pancakeMeta?.fromCache ? "(cache)" : "(mới)"} | Meta: ${dashboardEscapeHtml(metaTime)} ${metaDaily?.fromCache ? "(cache)" : "(mới)"}</p></div><div class="btns"><a class="green" href="/dashboard-meta-month?limit=${limit}">Tháng hiện tại</a><a href="/dashboard-today?time_basis=meta&limit=${limit}">Dashboard giờ Meta</a><a href="/dashboard-today?time_basis=pancake&limit=${limit}">Dashboard giờ VN</a></div></div>
    <div class="filters"><div class="filter"><label>Số hội thoại lấy từ Pancake</label><select id="limitSelect" onchange="applyMonthFilters()"><option value="100" ${dashboardSelected("100", String(limit))}>100</option><option value="200" ${dashboardSelected("200", String(limit))}>200</option><option value="300" ${dashboardSelected("300", String(limit))}>300</option><option value="500" ${dashboardSelected("500", String(limit))}>500</option></select></div><div class="filter"><label>Tháng theo giờ Meta</label><input id="monthInput" type="month" value="${dashboardEscapeHtml(monthData.targetMonth)}" onchange="applyMonthFilters()"/></div><div class="filter"><label>Ghi chú</label><input value="Chi tiêu đã nhân hệ số thuế: ${dashboardEscapeHtml(String(META_SPEND_TAX_MULTIPLIER || 1))}" readonly/></div></div>${metaNotice}<div class="notice">Bảng này gom ngày theo <b>giờ tài khoản quảng cáo</b>, không theo giờ Việt Nam. Cột tin nhắn/SĐT/Zalo ở chế độ Meta lấy từ <b>message_events nội bộ</b>, không còn phụ thuộc giới hạn 500 hội thoại Pancake. Cột chi tiêu lấy từ Meta Insights; nếu cần cộng thuế, đặt biến Render <b>META_SPEND_TAX_MULTIPLIER</b>. Cột tên tài khoản QC tách riêng, tên hiển thị đậm và ID hiển thị nhỏ bên dưới; dữ liệu gom từ <b>META_AD_ACCOUNT_IDS</b> và tự quét các tài khoản token có quyền đọc. Có thể tắt tự quét bằng <b>META_AUTO_AD_ACCOUNTS=false</b>. Cột Visa/phương thức ưu tiên dữ liệu thanh toán tự động từ <b>/payment-webhook</b>, sau đó tới <b>META_ACCOUNT_CARD_MAP</b> hoặc <b>META_CARD_LAST4</b>.</div>
    <div class="summary"><div class="card"><div class="label">Tổng chi tiêu tháng</div><div class="num">${dashboardMoney(monthData.totalRow.spend)}</div></div><div class="card"><div class="label">Tổng tin nhắn</div><div class="num">${monthData.totalRow.total}</div></div><div class="card"><div class="label">Tổng SĐT</div><div class="num">${monthData.totalRow.hasPhone}</div></div><div class="card"><div class="label">Tỷ lệ lấy số</div><div class="num">${dashboardRate(monthData.totalRow.hasPhone, monthData.totalRow.total)}%</div></div></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Ngày tháng theo giờ Meta</th><th>Tổng chi tiêu tất cả tài khoản</th><th>Tên tài khoản quảng cáo</th><th>Chi tiêu theo tài khoản</th><th>Số tin nhắn trong ngày</th><th>Số lượng SĐT</th><th>Số lượng Zalo</th><th>Thẻ Visa / Phương thức</th></tr></thead><tbody>${rowHtml}</tbody></table></div></div><script>function applyMonthFilters(){const limit=document.getElementById('limitSelect').value;const month=document.getElementById('monthInput').value;const p=new URLSearchParams();p.set('limit',limit);if(month)p.set('month',month);window.location.href='/dashboard-meta-month?'+p.toString();}</script></body></html>`;
}

function dashboardAdRowClass(row) {
    const rate = row.total ? (row.hasPhone / row.total) * 100 : 0;
    if (rate >= 35) return "row-good";
    if (rate >= 20) return "row-mid";
    return "row-low";
}

function dashboardBuildAdStats(report, metaData, supplementalReport = [], dataSource = "meta") {
    const map = {};
    const allowedAdIds = new Set((metaData?.ads || []).map(ad => String(ad.adId)));

    // Meta là nguồn chính: chỉ tạo dòng cho QC có spend > 0 trong khoảng đã chọn.
    for (const ad of metaData?.ads || []) {
        map[String(ad.adId)] = {
            adId: String(ad.adId),
            accountId: ad.accountId || "",
            accountName: ad.accountName || "",
            accountLabel: ad.accountLabel || "",
            cardLast4: ad.cardLast4 || "",
            name: ad.name || `QC ${ad.adId}`,
            status: ad.status || "UNKNOWN",
            campaignName: ad.campaignName || "",
            adsetName: ad.adsetName || "",
            spend: Number(ad.spend || 0),
            impressions: Number(ad.impressions || 0),
            clicks: Number(ad.clicks || 0),
            reach: Number(ad.reach || 0),
            cpc: Number(ad.cpc || 0),
            cpm: Number(ad.cpm || 0),
            ctr: Number(ad.ctr || 0),
            metaMessages: Number(ad.messagingCount || 0),
            total: 0,
            hasPhone: 0,
            noPhone: 0,
            zalo: 0,
            called: 0,
            hotNoPhone: 0,
            productCount: {},
            tagCount: {},
            staffCount: {}
        };
    }

    // Map SĐT/Zalo từ webhook/Pancake vào những QC đang có spend.
    // QUAN TRỌNG 3.9.2: nếu chọn Meta trực tiếp, số HỘI THOẠI phải lấy từ Meta Insights (actions),
    // không được lấy tổng hội thoại từ webhook/Pancake vì sẽ lệch Ads Manager.
    const mergedItems = [];
    const seenLeadKeys = new Set();
    const leadSourceItems = dataSource === "pancake" ? (report || []) : [...(report || []), ...(supplementalReport || [])];
    for (const item of leadSourceItems) {
        const ids = Array.isArray(item.ad_ids) ? item.ad_ids.map(dashboardNormalizeAdId).filter(Boolean) : [];
        const matchedIds = ids.filter(id => allowedAdIds.has(id));
        if (!matchedIds.length) continue;
        for (const adId of matchedIds) {
            const leadKey = `${adId}:${item.conversation_id || item.sender_id || item.name || item.snippet || Math.random()}`;
            if (seenLeadKeys.has(leadKey)) continue;
            seenLeadKeys.add(leadKey);
            mergedItems.push({ adId, item });
        }
    }

    for (const { adId, item } of mergedItems) {
        const row = map[adId];
        if (!row) continue;
        if (dataSource === "pancake") row.total++;
        if (item.has_phone) row.hasPhone++;
        if ((item.tags || []).includes("Zalo") || item.has_zalo) row.zalo++;
        if ((item.tags || []).includes("Đã Gọi")) row.called++;
        if (item.hot_lead && !item.has_phone) row.hotNoPhone++;
        const product = item.product || "Khác";
        row.productCount[product] = (row.productCount[product] || 0) + 1;
        dashboardAddCounts(row.tagCount, item.tags || []);
        dashboardAddCounts(row.staffCount, (item.tags || []).filter(tag => DASHBOARD_STAFF_TAGS.includes(tag)));
    }

    for (const row of Object.values(map)) {
        if (dataSource === "meta") {
            // Meta Direct: khớp Ads Manager. Hội thoại = Meta messaging actions, không cộng webhook.
            row.total = Number(row.metaMessages || 0);
            // SĐT/Zalo chỉ là dữ liệu bổ sung từ webhook, không được làm tổng hội thoại tăng lên.
            if (row.hasPhone > row.total) row.hasPhone = row.total;
            if (row.zalo > row.total) row.zalo = row.total;
        } else if (dataSource === "pancake") {
            // Pancake: hội thoại = số hội thoại thực lấy từ Pancake/webhook đã map được ad_id.
            row.total = Number(row.total || 0);
        } else {
            // Compare/khác: ưu tiên không thấp hơn Meta, nhưng không dùng cho đối chiếu Ads Manager.
            row.total = Math.max(Number(row.total || 0), Number(row.metaMessages || 0));
        }
        row.noPhone = Math.max(0, Number(row.total || 0) - Number(row.hasPhone || 0));
    }

    return Object.values(map).sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
}

function dashboardRenderHtml({ title, limit, fullTotal, report, req, mode, pancakeMeta, metaData, metaDaily = null, dateRange, dataSource = "meta", compareStats = null, pancakeReport = [] }) {
    const currentDataSource = String(dataSource || req.query.data_source || "meta");
    const stats = dashboardBuildStats(report);
    const adsStats = dashboardBuildAdStats(report, metaData, currentDataSource === "pancake" ? [] : pancakeReport, currentDataSource);
    const currentLimit = String(limit || 500);
    const currentProduct = dashboardProductParamFromName(dashboardNormalizeProduct(req.query.product || "all"));
    const currentView = dashboardGetViewValue(req, mode);
    const currentDate = req.query.date || (dateRange.basis === "meta" ? dashboardTodayKeyMeta(0) : dashboardTodayKeyVN(0));
    const currentTimeBasis = dateRange.basis || "pancake";
    const totalSpend = Number(metaData?.totalSpend || 0);
    const adLevelConversations = adsStats.reduce((sum, x) => sum + Number(x.total || 0), 0);
    // 3.9.4: Khi xem Meta Direct, tổng hội thoại phải lấy từ Meta account/day insights
    // để khớp Ads Manager và báo cáo tháng. Không dùng tổng cộng theo ad-level nếu Meta trả lệch.
    const metaDirectConversations = Number(metaDaily?.totalMessages || 0);
    // AIGUKA 3.9.5: Chế độ Meta Direct tuyệt đối không fallback sang webhook/Pancake.
    // Nếu Meta trả 0 thì hiển thị 0 để phát hiện lỗi token/metric, không dùng số nội bộ thay thế.
    const totalAdConversations = currentDataSource === "meta"
        ? metaDirectConversations
        : currentDataSource === "pancake"
            ? Number(stats.total || 0)
            : (adLevelConversations || stats.total);
    const totalAdPhones = currentDataSource === "pancake"
        ? Number(stats.hasPhone || 0)
        : adsStats.reduce((sum, x) => sum + Number(x.hasPhone || 0), 0);
    const totalCostPerConversation = dashboardCost(totalSpend, totalAdConversations || stats.total);
    const totalCostPerPhone = dashboardCost(totalSpend, totalAdPhones || stats.hasPhone);
    const conversationCardLabel = currentDataSource === "meta" ? "Hội thoại Meta Account" : currentDataSource === "pancake" ? "Hội thoại Pancake" : "Hội thoại so sánh";
    const phoneCardLabel = currentDataSource === "pancake" ? "SĐT Pancake" : "SĐT từ QC có spend";
    const metaTime = metaData?.fetchedAt ? new Date(metaData.fetchedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : "Chưa có";
    const pancakeTime = pancakeMeta?.fetchedAt ? new Date(pancakeMeta.fetchedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : "Chưa có";
    const metaNotice = metaData?.error ? `<div class="notice red-note">Meta Ads: ${dashboardEscapeHtml(metaData.error)}</div>` : "";
    const pancakeNotice = pancakeMeta?.error
        ? `<div class="notice red-note"><b>⚠ Pancake đang lỗi hoặc không phản hồi.</b><br/>Lỗi: ${dashboardEscapeHtml(pancakeMeta.error)}<br/>Dashboard vẫn chạy bằng dữ liệu <b>Meta trực tiếp</b>${pancakeMeta?.fromCache ? " và cache Pancake gần nhất" : ""}. Nhân viên vẫn nên kiểm tra Pancake riêng nếu cần thao tác CRM.</div>`
        : `<div class="notice green-note"><b>✓ Pancake đang kết nối bình thường.</b> Cập nhật lúc ${dashboardEscapeHtml(pancakeTime)}${pancakeMeta?.fromCache ? " (đang dùng cache)" : ""}.</div>`;
    const compareNotice = compareStats ? `<div class="notice"><b>So sánh Meta trực tiếp / Pancake:</b> Hội thoại ${compareStats.meta_total}/${compareStats.pancake_total}, SĐT ${compareStats.meta_phone}/${compareStats.pancake_phone}, Zalo ${compareStats.meta_zalo}/${compareStats.pancake_zalo}.</div>` : "";
    const sourceBadge = currentDataSource === "pancake"
        ? `<span class="source-badge source-pancake">🟠 Pancake</span>`
        : currentDataSource === "compare"
            ? `<span class="source-badge source-compare">🔵 So sánh Meta/Pancake</span>`
            : `<span class="source-badge source-meta">🟢 Meta Direct</span>`;
    const sourceHint = currentDataSource === "meta"
        ? `<div class="notice green-note">${sourceBadge}<b>Đang xem dữ liệu Meta trực tiếp.</b> Hội thoại tổng lấy từ <b>Meta account/day Insights</b> để khớp Ads Manager và báo cáo tháng; SĐT/Zalo chỉ lấy bổ sung từ webhook/Pancake khi có.</div>`
        : currentDataSource === "compare"
            ? `<div class="notice">${sourceBadge}<b>Đang so sánh hai nguồn.</b> Meta lấy toàn bộ dữ liệu nội bộ theo khoảng ngày; giới hạn 100/300/500 chỉ áp dụng cho Pancake.</div>`
            : `<div class="notice">${sourceBadge}<b>Đang xem dữ liệu Pancake.</b> Giới hạn hội thoại Pancake áp dụng theo lựa chọn 100/300/500.</div>`;

    const adInfoByAdId = {};
    for (const ad of metaData?.ads || []) {
        if (!ad || !ad.adId) continue;
        adInfoByAdId[String(ad.adId)] = ad;
    }
    function dashboardCustomerAdCell(x = {}) {
        const adIds = Array.isArray(x.ad_ids) ? x.ad_ids.map(String).filter(Boolean) : [];
        const explicitName = x.ad_name || x.adName || x.latest_ad_name || "";
        const explicitAccount = x.ad_account_name || x.adAccountName || x.accountLabel || x.ad_account_id || x.account_id || "";
        const matched = adIds.map(id => adInfoByAdId[id]).find(Boolean);
        const adName = explicitName || matched?.name || (adIds[0] ? `QC ${adIds[0]}` : "Không rõ QC");
        const accountText = explicitAccount || matched?.accountLabel || matched?.accountName || matched?.accountId || "";
        const idText = adIds[0] || matched?.adId || "";
        return `<b>${dashboardEscapeHtml(adName)}</b>${accountText ? `<br><span>${dashboardEscapeHtml(accountText)}</span>` : ""}${idText ? `<br><span>${dashboardEscapeHtml(idText)}</span>` : ""}`;
    }

    const adsRows = adsStats.map((x, index) => `
        <tr class="${dashboardAdRowClass(x)}">
            <td>${index + 1}</td>
            <td><b>${dashboardEscapeHtml(x.name)}</b><br><span>${dashboardEscapeHtml(x.adId)}</span><br><span>${dashboardEscapeHtml(x.campaignName || "")}</span></td>
            <td>${dashboardEscapeHtml(x.accountLabel || x.accountId || "")}</td>
            <td><span class="status">${dashboardEscapeHtml(x.status)}</span></td>
            <td><b>${dashboardMoney(x.spend)}</b></td>
            <td><b>${x.total}</b></td>
            <td><b>${x.hasPhone}</b><br><span>${dashboardRate(x.hasPhone, x.total)}%</span></td>
            <td>${x.noPhone}</td>
            <td><b>${x.zalo}</b><br><span>${dashboardRate(x.zalo, x.total)}%</span></td>
            <td>${x.called}</td>
            <td>${x.hotNoPhone}</td>
            <td>${dashboardEscapeHtml(dashboardCountSummary(x.staffCount, 4))}</td>
            <td>${dashboardEscapeHtml(dashboardCountSummary(x.tagCount, 7))}</td>
            <td>${dashboardEscapeHtml(dashboardProductSummary(x.productCount))}</td>
            <td class="adv adv-cpcv">${dashboardCost(x.spend, x.total)}</td>
            <td class="adv adv-cpps">${dashboardCost(x.spend, x.hasPhone)}</td>
            <td class="adv adv-cpc">${x.cpc ? dashboardMoney(x.cpc) : "--"}</td>
            <td class="adv adv-cpm">${x.cpm ? dashboardMoney(x.cpm) : "--"}</td>
            <td class="adv adv-ctr">${x.ctr ? `${Number(x.ctr).toFixed(2)}%` : "--"}</td>
        </tr>
    `).join("");

    const hotRows = stats.hotNoPhone.slice(0, 50).map((x, index) => `
        <tr class="row-hot">
            <td>${index + 1}</td>
            <td><b>${dashboardEscapeHtml(x.name)}</b><br><span>${dashboardEscapeHtml(x.conversation_id)}</span></td>
            <td>${dashboardCustomerAdCell(x)}</td>
            <td>${dashboardEscapeHtml(x.product)}</td>
            <td>${dashboardEscapeHtml(dashboardFormatTags(x.tags))}</td>
            <td>${dashboardEscapeHtml(x.updated_at || "")}</td>
            <td>${dashboardEscapeHtml(x.snippet || "")}</td>
        </tr>
    `).join("");

    const phoneRows = report.filter(x => x.has_phone).slice(0, 50).map((x, index) => `
        <tr class="row-phone">
            <td>${index + 1}</td>
            <td><b>${dashboardEscapeHtml(x.name)}</b></td>
            <td>${dashboardCustomerAdCell(x)}</td>
            <td><b>${dashboardEscapeHtml(x.phones.join(", ") || "Có số nhưng chưa đọc được số")}</b></td>
            <td>${dashboardEscapeHtml(x.product)}</td>
            <td>${dashboardEscapeHtml(dashboardFormatTags(x.tags))}</td>
        </tr>
    `).join("");

    const noPhoneRows = report.filter(x => !x.has_phone).slice(0, 50).map((x, index) => `
        <tr class="row-normal">
            <td>${index + 1}</td>
            <td><b>${dashboardEscapeHtml(x.name)}</b><br><span>${dashboardEscapeHtml(x.conversation_id)}</span></td>
            <td>${dashboardCustomerAdCell(x)}</td>
            <td>${dashboardEscapeHtml(x.product)}</td>
            <td>${dashboardEscapeHtml(dashboardFormatTags(x.tags))}</td>
            <td>${dashboardEscapeHtml(x.updated_at || "")}</td>
            <td>${dashboardEscapeHtml(x.snippet || "")}</td>
        </tr>
    `).join("");

    return `<!doctype html>
<html lang="vi">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIGUKA Dashboard 3.9.2</title>
    <style>
        body { margin:0; font-family:"Times New Roman", Times, serif; font-size:14px; background:#f8fafc; color:#111827; }
        .wrap { max-width:1480px; margin:0 auto; padding:18px; }
        .header { display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:16px; }
        .header h1 { margin:0; font-size:28px; }
        .header p { margin:6px 0 0; color:#64748b; }
        .btns a { display:inline-block; margin-left:8px; padding:10px 12px; border-radius:10px; background:#2563eb; color:white; text-decoration:none; font-size:14px; }
        .btns a.red { background:#ef4444; } .btns a.green { background:#16a34a; }
        .filters { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:10px; background:white; padding:14px; border-radius:16px; box-shadow:0 1px 4px rgba(15,23,42,.08); margin-bottom:14px; border:1px solid #e2e8f0; }
        .filter label { display:block; font-size:13px; color:#64748b; margin-bottom:5px; }
        .filter select,.filter input { width:100%; box-sizing:border-box; padding:10px; border-radius:10px; border:1px solid #cbd5e1; font-size:14px; background:#f8fafc; font-family:"Times New Roman", Times, serif; }
        .grid { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; }
        .card { background:white; border-radius:16px; padding:16px; box-shadow:0 1px 4px rgba(15,23,42,.08); border:1px solid #e2e8f0; }
        .card.blue { background:#eff6ff; border-color:#bfdbfe; } .card.green { background:#ecfdf5; border-color:#bbf7d0; } .card.red { background:#fef2f2; border-color:#fecaca; }
        .card.orange { background:#fff7ed; border-color:#fed7aa; } .card.pink { background:#fdf2f8; border-color:#fbcfe8; }
        .card .label { color:#475569; font-size:14px; } .card .num { margin-top:8px; font-size:28px; font-weight:800; color:#0f172a; }
        .section { margin-top:16px; }
        .section-head { display:flex; justify-content:space-between; align-items:center; gap:12px; background:#e0f2fe; border:1px solid #bae6fd; border-radius:14px; padding:12px 14px; margin-bottom:10px; }
        .section-head h2 { margin:0; font-size:21px; }
        .section-actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-weight:bold; }
        .toggle-btn { border:1px solid #0284c7; background:white; color:#075985; padding:7px 11px; border-radius:999px; cursor:pointer; font-family:"Times New Roman", Times, serif; font-weight:bold; }
        .advanced-box { display:none; background:white; border:1px dashed #94a3b8; padding:10px 12px; border-radius:12px; margin:8px 0 10px; }
        .advanced-box label { margin-right:16px; white-space:nowrap; }
        .table-wrap { overflow-x:auto; border-radius:16px; box-shadow:0 1px 4px rgba(15,23,42,.08); border:1px solid #e2e8f0; }
        table { width:100%; border-collapse:collapse; background:white; min-width:1200px; }
        th,td { padding:11px 12px; border-bottom:1px solid #e2e8f0; text-align:left; vertical-align:top; font-size:14px; line-height:1.35; }
        th { background:#e0f2fe; color:#0f172a; font-weight:800; position:sticky; top:0; } td span { color:#64748b; font-size:13px; }
        tbody tr:nth-child(even){background:#f8fafc;} .row-good{background:#dcfce7!important;} .row-mid{background:#fef9c3!important;} .row-low{background:#ffe4e6!important;} .row-hot{background:#ffedd5!important;} .row-phone{background:#ecfdf5!important;} .row-normal{background:#f8fafc;}
        .products { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; } .product { background:white; border-radius:14px; padding:13px; box-shadow:0 1px 4px rgba(15,23,42,.08); border:1px solid #e2e8f0; }
        .product b{display:block; font-size:22px; margin-top:6px;} .notice{background:#fff7ed; border:1px solid #fed7aa; padding:12px; border-radius:12px; margin-top:12px; color:#9a3412;} .red-note{background:#fef2f2; border-color:#fecaca; color:#991b1b;} .green-note{background:#ecfdf5; border-color:#bbf7d0; color:#166534;} .source-badge{display:inline-block; padding:6px 10px; border-radius:999px; font-weight:800; font-size:13px; margin-right:6px;} .source-meta{background:#dcfce7; color:#166534;} .source-pancake{background:#ffedd5; color:#9a3412;} .source-compare{background:#dbeafe; color:#1d4ed8;}
        .legend{display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 10px; color:#475569; font-size:13px;} .chip{padding:6px 10px; border-radius:999px; border:1px solid #e2e8f0; background:white;} .chip.good{background:#dcfce7;} .chip.mid{background:#fef9c3;} .chip.low{background:#ffe4e6;}
        .adv { display:none; }
        @media (max-width:900px){.grid{grid-template-columns:repeat(2,1fr);} .products{grid-template-columns:repeat(2,1fr);} .filters{grid-template-columns:repeat(1,1fr);} .header{display:block;} .btns{margin-top:12px;} .btns a{margin:4px 4px 0 0;} th,td{font-size:12px;padding:9px;} .section-head{display:block;} .section-actions{margin-top:8px;} }
    </style>
</head>
<body>
<div class="wrap">
    <div class="header">
        <div>
            <h1>🤖 AIGUKA AI SALES DASHBOARD 3.9.2</h1>
            <p>${dashboardEscapeHtml(title)} | Nguồn ${dashboardEscapeHtml(currentDataSource)} | Nội bộ/Pancake đã lấy ${fullTotal}/${limit} hội thoại | Meta Direct hiển thị ${totalAdConversations} hội thoại | Cập nhật: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
            <p>Pancake: ${dashboardEscapeHtml(pancakeTime)} ${pancakeMeta?.fromCache ? "(cache)" : "(mới)"} | Meta: ${dashboardEscapeHtml(metaTime)} ${metaData?.fromCache ? "(cache)" : "(mới)"} | Bộ lọc: ${dashboardEscapeHtml(dashboardTimeBasisLabel(currentTimeBasis))} | Khoảng: ${dashboardEscapeHtml(dateRange.label)}</p>
        </div>
        <div class="btns">
            <a class="green" href="/dashboard-today?time_basis=${currentTimeBasis}&limit=${currentLimit}">Hôm nay</a>
            <a href="/dashboard-yesterday?time_basis=${currentTimeBasis}&limit=${currentLimit}">Hôm qua</a>
            <a href="/dashboard?preset=last_7d&time_basis=${currentTimeBasis}&limit=${currentLimit}">7 ngày</a>
            <a href="/dashboard?preset=last_30d&time_basis=${currentTimeBasis}&limit=${currentLimit}">30 ngày</a>
            <a class="red" href="/dashboard-hot?time_basis=${currentTimeBasis}&limit=${currentLimit}">Khách nóng</a>
            <a href="/dashboard-meta-month?limit=${currentLimit}">Báo cáo tháng Meta</a>
            <a href="/pancake-report-text?limit=${currentLimit}">Bản text</a>
        </div>
    </div>

    <div class="filters">
        <div class="filter" id="pancakeLimitFilter" style="${currentDataSource === "meta" ? "display:none" : ""}"><label>Giới hạn hội thoại Pancake</label><select id="limitSelect" onchange="applyDashboardFilters()"><option ${dashboardSelected(100,currentLimit)} value="100">100</option><option ${dashboardSelected(300,currentLimit)} value="300">300</option><option ${dashboardSelected(500,currentLimit)} value="500">500</option></select></div>
        <div class="filter"><label>Nguồn tin nhắn</label><select id="dataSourceSelect" onchange="togglePancakeLimitFilter(); applyDashboardFilters()"><option value="meta" ${dashboardSelected("meta",currentDataSource)}>Meta trực tiếp</option><option value="pancake" ${dashboardSelected("pancake",currentDataSource)}>Pancake</option><option value="compare" ${dashboardSelected("compare",currentDataSource)}>So sánh Meta/Pancake</option></select></div>
        <div class="filter"><label>Thống kê khách theo</label><select id="timeBasisSelect" onchange="applyDashboardFilters()"><option value="pancake" ${dashboardSelected("pancake",currentTimeBasis)}>Giờ Pancake / Việt Nam</option><option value="meta" ${dashboardSelected("meta",currentTimeBasis)}>Giờ tài khoản quảng cáo</option></select></div>
        <div class="filter"><label>Khoảng xem</label><select id="viewSelect" onchange="applyDashboardFilters()"><option value="today" ${dashboardSelected("today",currentView)}>Hôm nay</option><option value="yesterday" ${dashboardSelected("yesterday",currentView)}>Hôm qua</option><option value="last_7d" ${dashboardSelected("last_7d",currentView)}>7 ngày</option><option value="last_30d" ${dashboardSelected("last_30d",currentView)}>30 ngày</option><option value="date" ${dashboardSelected("date",currentView)}>Ngày cụ thể</option><option value="hot" ${dashboardSelected("hot",currentView)}>Khách nóng</option></select></div>
        <div class="filter"><label>Ngày cụ thể</label><input id="dateInput" type="date" value="${dashboardEscapeHtml(currentDate)}" onchange="document.getElementById('viewSelect').value='date'; applyDashboardFilters();" /></div>
        <div class="filter"><label>Sản phẩm</label><select id="productSelect" onchange="applyDashboardFilters()"><option value="all" ${dashboardSelected("all",currentProduct)}>Tất cả</option><option value="quat" ${dashboardSelected("quat",currentProduct)}>Quạt</option><option value="thiet_bi_ve_sinh" ${dashboardSelected("thiet_bi_ve_sinh",currentProduct)}>Thiết bị vệ sinh</option><option value="combo" ${dashboardSelected("combo",currentProduct)}>Combo phòng tắm</option><option value="bep" ${dashboardSelected("bep",currentProduct)}>Bếp</option><option value="bon_tam" ${dashboardSelected("bon_tam",currentProduct)}>Bồn tắm</option><option value="khac" ${dashboardSelected("khac",currentProduct)}>Khác</option></select></div>
        <div class="filter"><label>Thao tác</label><select onchange="if(this.value) window.location.href=this.value"><option value="">Mở nhanh...</option><option value="/dashboard-today?time_basis=${currentTimeBasis}&limit=${currentLimit}">Hôm nay</option><option value="/dashboard-yesterday?time_basis=${currentTimeBasis}&limit=${currentLimit}">Hôm qua</option><option value="/dashboard?preset=last_7d&time_basis=${currentTimeBasis}&limit=${currentLimit}">7 ngày</option><option value="/dashboard?preset=last_30d&time_basis=${currentTimeBasis}&limit=${currentLimit}">30 ngày</option><option value="/dashboard-meta-month?limit=${currentLimit}">Báo cáo tháng Meta</option><option value="/pancake-report-text?limit=${currentLimit}">Bản text</option></select></div>
    </div>

    ${metaNotice}
    ${sourceHint}
    ${pancakeNotice}
    ${compareNotice}
    <div class="notice">Các chỉ số khách đang lọc theo <b>${dashboardEscapeHtml(dashboardTimeBasisLabel(currentTimeBasis))}</b>. Nếu chọn giờ Meta, ngày sẽ chạy theo ngày tài khoản quảng cáo chứ không theo ngày Việt Nam.</div>

    <div class="grid">
        <div class="card green"><div class="label">Tổng chi tiêu</div><div class="num">${dashboardMoney(totalSpend)}</div></div>
        <div class="card blue"><div class="label">${conversationCardLabel}</div><div class="num">${totalAdConversations}</div></div>
        <div class="card green"><div class="label">${phoneCardLabel}</div><div class="num">${totalAdPhones}</div></div>
        <div class="card orange"><div class="label">Khách nóng</div><div class="num">${stats.hotNoPhone.length}</div></div>
        <div class="card pink"><div class="label">Cost/Hội thoại</div><div class="num">${totalCostPerConversation}</div></div>
        <div class="card red"><div class="label">Cost/SĐT</div><div class="num">${totalCostPerPhone}</div></div>
    </div>

    <div class="section" id="ads">
        <div class="section-head">
            <h2>📊 Hiệu quả theo quảng cáo</h2>
            <div class="section-actions"><button class="toggle-btn" onclick="toggleAdsTable()">Ẩn/Hiện ▼</button><span>Tổng chi tiêu: ${dashboardMoney(totalSpend)}</span></div>
        </div>
        <div class="notice">Bảng này chỉ hiển thị các quảng cáo có chi tiêu &gt; 0 trong đúng khoảng thời gian đã chọn. Các mã quảng cáo từ Pancake nhưng không tiêu tiền trong khoảng này sẽ không hiển thị để báo cáo khớp Ads Manager.</div>
        <div class="advanced-box" id="advancedBox"><b>📈 Chỉ số nâng cao:</b><label><input type="checkbox" data-col="adv-cpcv" onchange="toggleAdvancedColumns()"> Cost/Hội thoại</label><label><input type="checkbox" data-col="adv-cpps" onchange="toggleAdvancedColumns()"> Cost/SĐT</label><label><input type="checkbox" data-col="adv-cpc" onchange="toggleAdvancedColumns()"> CPC</label><label><input type="checkbox" data-col="adv-cpm" onchange="toggleAdvancedColumns()"> CPM</label><label><input type="checkbox" data-col="adv-ctr" onchange="toggleAdvancedColumns()"> CTR</label></div>
        <button class="toggle-btn" onclick="toggleAdvancedBox()">📈 Chỉ số nâng cao ▶</button>
        <div class="legend"><span class="chip good">Xanh: tỷ lệ SĐT ≥35%</span><span class="chip mid">Vàng: 20%-34.9%</span><span class="chip low">Hồng: dưới 20%</span></div>
        <div class="table-wrap" id="adsTableWrap"><table><thead><tr><th>#</th><th>Quảng cáo</th><th>Tài khoản QC</th><th>Trạng thái</th><th>Chi tiêu</th><th>Hội thoại</th><th>Có SĐT</th><th>Chưa SĐT</th><th>Zalo</th><th>Đã gọi</th><th>Khách nóng</th><th>Nhân viên</th><th>Tags</th><th>Sản phẩm</th><th class="adv adv-cpcv">Cost/Hội thoại</th><th class="adv adv-cpps">Cost/SĐT</th><th class="adv adv-cpc">CPC</th><th class="adv adv-cpm">CPM</th><th class="adv adv-ctr">CTR</th></tr></thead><tbody>${adsRows || `<tr><td colspan="19">Không có quảng cáo nào tiêu tiền trong khoảng này hoặc Meta API chưa trả dữ liệu.</td></tr>`}</tbody></table></div>
    </div>

    <div class="section"><h2>Phân loại sản phẩm</h2><div class="products"><div class="product">Quạt <b>${stats.productCount.quat}</b></div><div class="product">Thiết bị vệ sinh <b>${stats.productCount.thietBiVeSinh}</b></div><div class="product">Combo phòng tắm <b>${stats.productCount.comboPhongTam}</b></div><div class="product">Bếp <b>${stats.productCount.bep}</b></div><div class="product">Bồn tắm <b>${stats.productCount.bonTam}</b></div><div class="product">Khác <b>${stats.productCount.khac}</b></div></div></div>
    <div class="section"><h2>🔥 Khách nóng chưa có số</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Khách</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Tags</th><th>Cập nhật</th><th>Nội dung gần nhất</th></tr></thead><tbody>${hotRows || `<tr><td colspan="7">Không có</td></tr>`}</tbody></table></div></div>
    <div class="section"><h2>📞 Khách đã có số</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Khách</th><th>Quảng cáo</th><th>Số điện thoại</th><th>Sản phẩm</th><th>Tags</th></tr></thead><tbody>${phoneRows || `<tr><td colspan="6">Không có</td></tr>`}</tbody></table></div></div>
    <div class="section"><h2>🕒 Khách chưa có số gần nhất</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Khách</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Tags</th><th>Cập nhật</th><th>Nội dung gần nhất</th></tr></thead><tbody>${noPhoneRows || `<tr><td colspan="7">Không có</td></tr>`}</tbody></table></div></div>
</div>
<script>
function toggleAdsTable(){ const el=document.getElementById('adsTableWrap'); if(!el)return; el.style.display=el.style.display==='none'?'block':'none'; localStorage.setItem('aiguka_ads_table',el.style.display); }
function toggleAdvancedBox(){ const el=document.getElementById('advancedBox'); if(!el)return; el.style.display=el.style.display==='block'?'none':'block'; localStorage.setItem('aiguka_adv_box',el.style.display); }
function toggleAdvancedColumns(){ document.querySelectorAll('#advancedBox input[type=checkbox]').forEach(cb=>{ const show=cb.checked; document.querySelectorAll('.'+cb.dataset.col).forEach(el=>{ el.style.display=show?'table-cell':'none'; }); localStorage.setItem('aiguka_'+cb.dataset.col,show?'1':'0'); }); }
function restoreDashboardState(){ const ads=document.getElementById('adsTableWrap'); if(ads && localStorage.getItem('aiguka_ads_table')) ads.style.display=localStorage.getItem('aiguka_ads_table'); const box=document.getElementById('advancedBox'); if(box && localStorage.getItem('aiguka_adv_box')) box.style.display=localStorage.getItem('aiguka_adv_box'); document.querySelectorAll('#advancedBox input[type=checkbox]').forEach(cb=>{ cb.checked=localStorage.getItem('aiguka_'+cb.dataset.col)==='1'; }); toggleAdvancedColumns(); }
function togglePancakeLimitFilter(){ const source=document.getElementById('dataSourceSelect')?document.getElementById('dataSourceSelect').value:'meta'; const box=document.getElementById('pancakeLimitFilter'); if(box) box.style.display=(source==='meta')?'none':''; }
function applyDashboardFilters(){ const limitEl=document.getElementById('limitSelect'); const limit=limitEl?limitEl.value:'500'; const view=document.getElementById('viewSelect').value; const product=document.getElementById('productSelect').value; const date=document.getElementById('dateInput').value; const timeBasis=document.getElementById('timeBasisSelect')?document.getElementById('timeBasisSelect').value:'pancake'; const dataSource=document.getElementById('dataSourceSelect')?document.getElementById('dataSourceSelect').value:'meta'; let path='/dashboard'; const params=new URLSearchParams(); if(dataSource!=='meta') params.set('limit',limit); params.set('time_basis',timeBasis); params.set('data_source',dataSource); if(product && product!=='all') params.set('product',product); if(view==='today'){path='/dashboard-today';} else if(view==='yesterday'){path='/dashboard-yesterday';} else if(view==='hot'){path='/dashboard-hot';} else if(view==='last_7d'){params.set('preset','last_7d');} else if(view==='last_30d'){params.set('preset','last_30d');} else if(view==='date'){if(date) params.set('date',date);} window.location.href=path+'?'+params.toString(); }
restoreDashboardState();
togglePancakeLimitFilter();
</script>
</body></html>`;
}

async function dashboardHandler(req, res, mode = "all") {
    try {
        const limit = req.query.limit || 500;
        const source = String(req.query.data_source || req.query.source || "meta").toLowerCase();
        const metaRows = buildInternalRowsFromMetaWebhook(limit);
        const pancakeResult = await dashboardFetchPancakeCached(limit);
        const pancakeRows = pancakeResult.conversations.map(pancakeBuildCustomerRow);
        let fullReport = metaRows;
        let compareStats = null;

        if (source === "pancake") fullReport = pancakeRows;
        if (source === "compare") {
            fullReport = metaRows;
            compareStats = buildMetaPancakeCompare(metaRows, pancakeRows);
        }

        const filtered = dashboardFilterReport(fullReport, req, mode);
        const metaData = await dashboardFetchMetaAdsCached(filtered.dateRange);
        const metaDaily = await dashboardFetchMetaDailyCached(filtered.dateRange);
        res.type('html').send(dashboardRenderHtml({
            title: filtered.title,
            limit,
            fullTotal: fullReport.length,
            report: filtered.report,
            req,
            mode,
            pancakeMeta: pancakeResult,
            metaData,
            metaDaily,
            dateRange: filtered.dateRange,
            dataSource: source,
            compareStats,
            pancakeReport: pancakeRows
        }));
    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).type('text/plain').send(`Lỗi khi mở dashboard: ${error.message}`);
    }
}

app.get('/dashboard', async (req, res) => {
    await dashboardHandler(req, res, "all");
});

app.get('/dashboard-today', async (req, res) => {
    await dashboardHandler(req, res, "today");
});

app.get('/dashboard-yesterday', async (req, res) => {
    await dashboardHandler(req, res, "yesterday");
});

app.get('/dashboard-hot', async (req, res) => {
    await dashboardHandler(req, res, "hot");
});

app.get('/dashboard-meta-month', async (req, res) => {
    try {
        const limit = req.query.limit || 500;
        const monthKey = String(req.query.month || dashboardTodayKeyMeta(0).slice(0, 7));
        const since = `${monthKey}-01`;
        const days = dashboardDaysInMonthFromKey(since);
        const todayMeta = dashboardTodayKeyMeta(0);
        const until = monthKey === todayMeta.slice(0, 7) ? todayMeta : `${monthKey}-${String(days).padStart(2, "0")}`;
        const dateRange = { since, until, label: `${since} → ${until}`, basis: "meta" };
        const dataSource = String(req.query.data_source || "meta").toLowerCase();
        const pancakeResult = await dashboardFetchPancakeCached(limit);
        const pancakeReport = pancakeResult.conversations.map(pancakeBuildCustomerRow);
        const fullReport = dataSource === "pancake" ? pancakeReport : buildInternalRowsFromMetaWebhook(1000000);
        const report = fullReport.filter(x => {
            const key = dashboardDateKeyMeta(x.updated_at || x.inserted_at || "");
            return key && key >= since && key <= until;
        });
        const metaDaily = await dashboardFetchMetaDailyCached(dateRange);
        res.type('html').send(dashboardRenderMetaMonthHtml({
            limit,
            fullTotal: fullReport.length,
            report,
            pancakeReport,
            pancakeMeta: pancakeResult,
            metaDaily,
            monthKey: since,
            dataSource
        }));
    } catch (error) {
        console.error("Meta month dashboard error:", error);
        res.status(500).type('text/plain').send(`Lỗi khi mở báo cáo tháng Meta: ${error.message}`);
    }
});



app.get('/dashboard-source-debug', async (req, res) => {
    try {
        const mode = String(req.query.mode || "today");
        const dateRange = dashboardGetMetaDateRange(req, mode);
        const limit = req.query.limit || 500;
        const metaDaily = await dashboardFetchMetaDailyCached(dateRange);
        const metaData = await dashboardFetchMetaAdsCached(dateRange);
        const pancakeResult = await dashboardFetchPancakeCached(limit);
        const pancakeRows = pancakeResult.conversations.map(pancakeBuildCustomerRow);
        const internalRows = buildInternalRowsFromMetaWebhook(1000000);
        const filteredInternal = dashboardFilterReport(internalRows, req, mode).report;
        const filteredPancake = dashboardFilterReport(pancakeRows, req, mode).report;
        const adsStatsMeta = dashboardBuildAdStats(filteredInternal, metaData, filteredPancake, "meta");
        const adsStatsPancake = dashboardBuildAdStats(filteredPancake, metaData, [], "pancake");
        res.json({
            success: true,
            version: "3.9.10",
            dateRange,
            meta: {
                totalMessages: Number(metaDaily?.totalMessages || 0),
                messageByDate: metaDaily?.messageByDate || {},
                totalSpend: metaDaily?.totalSpend || 0,
                error: metaDaily?.error || null,
                fromCache: Boolean(metaDaily?.fromCache)
            },
            adLevel: {
                metaSum: adsStatsMeta.reduce((sum, x) => sum + Number(x.total || 0), 0),
                pancakeSum: adsStatsPancake.reduce((sum, x) => sum + Number(x.total || 0), 0),
                rows: adsStatsMeta.map(x => ({ adId: x.adId, name: x.name, spend: x.spend, metaMessages: x.metaMessages, displayedMetaTotal: x.total, phones: x.hasPhone }))
            },
            internalWebhook: {
                total: filteredInternal.length,
                phones: filteredInternal.filter(x => x.has_phone).length,
                zalo: filteredInternal.filter(x => (x.tags || []).includes("Zalo") || x.has_zalo).length
            },
            pancake: {
                total: filteredPancake.length,
                phones: filteredPancake.filter(x => x.has_phone).length,
                zalo: filteredPancake.filter(x => (x.tags || []).includes("Zalo") || x.has_zalo).length,
                error: pancakeResult?.error || null,
                fromCache: Boolean(pancakeResult?.fromCache)
            }
        });
    } catch (error) {
        console.error("dashboard-source-debug error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


app.get('/internal-crm-debug', (req, res) => {
    const events = loadMessageEvents();
    const customers = loadInternalCustomers();
    res.json({
        ok: true,
        message_events: events.length,
        customers: Object.keys(customers).length,
        latest_events: events.slice(-10).reverse(),
        latest_customers: Object.values(customers).sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0)).slice(0, 20)
    });
});

app.get('/internal-customer-history', (req, res) => {
    const key = String(req.query.key || "");
    const sender = String(req.query.sender_id || "");
    const page = String(req.query.page_id || "");
    const targetKey = key || (sender ? makeInternalCustomerKey(page || "unknown_page", sender) : "");
    if (!targetKey) return res.status(400).send("Thiếu key hoặc sender_id");
    const events = loadMessageEvents().filter(e => e.customer_key === targetKey || (!key && sender && e.sender_id === sender));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(events.map(e => `[${e.created_at}] ${e.direction}: ${e.text}`).join("\n") || "Không có lịch sử nội bộ");
});


app.get('/meta-billing-debug', async (req, res) => {
    try {
        dashboardCache.metaAccounts = null;
        const accounts = await dashboardGetMetaAccounts();
        res.json({
            ok: true,
            fetchBillingDetails: META_FETCH_BILLING_DETAILS,
            count: accounts.length,
            accounts: accounts.map(a => ({
                id: a.id,
                name: a.name,
                cardLast4: a.cardLast4 || "",
                billingRead: a.billingRead,
                billingError: a.billingError || "",
                source: a.source || ""
            }))
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/meta-accounts-debug', async (req, res) => {
    try {
        const accounts = await dashboardGetMetaAccounts();
        res.json({
            ok: true,
            autoDiscovery: META_AUTO_AD_ACCOUNTS,
            configuredIds: dashboardParseAccountList(META_AD_ACCOUNT_IDS || META_AD_ACCOUNT_ID),
            count: accounts.length,
            accounts
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/payment-webhook', (req, res) => {
    try {
        const text = req.body?.text || req.body?.message || req.body?.sms || "";
        const accountId = req.body?.account_id || req.body?.accountId || "";
        const event = dashboardParsePaymentText(text, accountId);
        if (!event.cardLast4) {
            return res.status(400).json({ success: false, error: "Không đọc được 4 số cuối thẻ từ nội dung gửi lên", parsed: event });
        }
        const events = dashboardLoadPaymentEvents();
        events.push(event);
        dashboardSavePaymentEvents(events);
        res.json({ success: true, event });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/payment-debug', (req, res) => {
    const events = dashboardLoadPaymentEvents().slice(-50).reverse();
    res.json({ success: true, count: events.length, events });
});

app.get('/meta-debug', async (req, res) => {
    try {
        const dateRange = {
            since: req.query.since || dashboardTodayKeyVN(-1),
            until: req.query.until || req.query.since || dashboardTodayKeyVN(-1),
            label: `${req.query.since || dashboardTodayKeyVN(-1)} → ${req.query.until || req.query.since || dashboardTodayKeyVN(-1)}`
        };
        const metaData = await dashboardFetchMetaAdsCached(dateRange);
        res.json({
            success: !metaData.error,
            account: META_AD_ACCOUNT_ID,
            dateRange,
            error: metaData.error,
            totalSpend: metaData.totalSpend,
            totalSpendFormatted: dashboardMoney(metaData.totalSpend),
            ads: metaData.ads.map(x => ({ ad_id: x.adId, name: x.name, status: x.status, spend: x.spend, spendFormatted: dashboardMoney(x.spend) }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== END DASHBOARD MODULE =====


// ===== END PANCAKE REPORT MODULE =====


function startBackgroundJobs() {
    loadAdMappingsFromSupabase().catch(console.error);
    loadProductItemsFromSupabase().catch(console.error);
    loadWorkingSettingsFromSupabase().catch(console.error);
    setInterval(() => loadAdMappingsFromSupabase().catch(console.error), 5 * 60 * 1000);
    setInterval(() => loadProductItemsFromSupabase().catch(console.error), 5 * 60 * 1000);
    setInterval(() => loadWorkingSettingsFromSupabase().catch(console.error), 60 * 1000);

    // Rà 1 lần khi máy chủ online lại.
    // Chỉ gửi nếu khách im 12-20h, chưa có số/Zalo, đã nhắn >= 2 tin, xác định được đúng sản phẩm, và chưa từng chăm sóc.
    setTimeout(() => {
        checkFollowUpsOnStart().catch(console.error);
    }, 5000);

    // Durable Pending Reply Queue: khi Render ngủ/restart, timer RAM mất.
    // Worker này quét Supabase.pending_replies để trả lời các lịch đã quá hạn.
    setTimeout(() => {
        processDuePendingReplies(50).catch(console.error);
    }, 8000);

    setInterval(() => {
        processDuePendingReplies(20).catch(console.error);
    }, 60 * 1000);

    // Khi server còn online, kiểm tra lại mỗi 2 giờ để giảm tần suất tự động.
    setInterval(() => {
        checkFollowUpsOnStart().catch(console.error);
    }, 2 * 60 * 60 * 1000);
}

module.exports = {
    app,
    startBackgroundJobs
};
