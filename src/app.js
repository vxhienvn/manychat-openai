const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { loadProductRows, findBestProductRow, buildPriceRangeReply, buildProductIntroWithPrice } = require('./services/productSheetService');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
    return t.includes("zalo") || t.includes("za lo") || t.includes("zalo em") || t.includes("zalo anh") || t.includes("zalo chị");
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
        campaign_id: ref.campaign_id || ""
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

app.get('/', (req, res) => {
    res.send('Server OK - AIGUKA v3.9.0 Product Sheet Parser');
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

function detectExplicitTopic(message) {
    const msg = (message || "").toLowerCase();

    const fanWords = [
        "quạt", "quat", "quạt trần", "quat tran", "quạt đèn", "quat den",
        "guka", "5 cánh", "5 canh", "8 cánh", "8 canh", "10 cánh", "10 canh",
        "55w", "65w", "70w", "90w", "đèn không", "den khong", "đèn nhẹ", "den nhe",
        "không lòe", "khong loe"
    ];

    const kitchenWords = [
        "bếp", "bep", "thiết bị bếp", "thiet bi bep",
        "bếp từ", "bep tu", "hút mùi", "hut mui", "máy hút mùi", "may hut mui",
        "chậu rửa bát", "chau rua bat", "vòi bếp", "voi bep", "tủ bếp", "tu bep", "tủ", "tu", "tủ lavabo", "tu lavabo", "tủ chậu", "tu chau", "tủ nhà tắm", "tu nha tam"
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
        "tbvs", "bồn cầu", "bon cau", "bồn tắm", "bon tam", "gạch", "gach"
    ];

    const hasKitchen = kitchenWords.some(word => msg.includes(word));
    const hasBath = bathWords.some(word => msg.includes(word));
    const hasFan = fanWords.some(word => msg.includes(word));
    const hasFaucet = faucetWords.some(word => msg.includes(word));

    if (hasKitchen && hasBath) return "kitchen_bath";

    // Ưu tiên sản phẩm cụ thể khi khách hỏi rõ
    if (hasFan) return "fan";
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
    if (productType === "fan") {
        return "Đây là một số mẫu quạt phổ biến bên em ạ. Nếu anh cần nhiều mẫu hơn, màu khác, bản động cơ Nhật/Ý hoặc báo giá chi tiết, anh để lại SĐT/Zalo để bên em gửi catalogue đầy đủ và tư vấn kỹ hơn nhé?";
    }

    if (productType === "faucet") {
        return "Đây là một số mẫu sen vòi, lavabo, chậu rửa phổ biến bên em ạ. Nếu anh cần nhiều mẫu khác hoặc báo giá chi tiết theo bộ, anh để lại SĐT/Zalo để bên em gửi catalogue đầy đủ và tư vấn thêm nhé?";
    }

    if (productType === "combo") {
        return "Đây là một số combo thiết bị vệ sinh/phòng tắm phổ biến bên em ạ. Nếu anh cần nhiều mẫu khác, phối theo ngân sách hoặc báo giá chi tiết, anh để lại SĐT/Zalo để bên em gửi catalogue đầy đủ và tư vấn thêm nhé?";
    }

    if (productType === "kitchen" || productType === "kitchen_bath") {
        return "Đây là một số mẫu phổ biến bên em ạ. Nếu anh cần nhiều mẫu khác hoặc báo giá chi tiết theo bộ, anh để lại SĐT/Zalo để bên em gửi catalogue đầy đủ và tư vấn thêm nhé?";
    }

    return "Đây là một số mẫu phổ biến bên em ạ. Nếu anh cần nhiều mẫu khác hoặc báo giá chi tiết, anh để lại SĐT/Zalo để bên em gửi catalogue đầy đủ và tư vấn thêm nhé?";
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

async function sendMessage(senderId, text) {
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
}

async function sendTemplate(senderId, elements, logName) {
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
                        elements
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
    return Date.now() - Number(state.lastCarouselTime) < 5 * 60 * 1000;
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
}

async function sendImageGalleryByProduct(senderId, productType, limit = 4) {
    let items = [];

    if (productType === "combo") {
        items = PRODUCT_IMAGE_GALLERIES.combo;
    } else if (productType === "fan") {
        items = PRODUCT_IMAGE_GALLERIES.fan;
    } else if (productType === "faucet" || productType === "kitchen") {
        items = PRODUCT_IMAGE_GALLERIES.faucet;
    } else if (productType === "kitchen_bath") {
        items = PRODUCT_IMAGE_GALLERIES.combo.slice(0, 2).concat(PRODUCT_IMAGE_GALLERIES.faucet.slice(0, 2));
    }

    if (!items || items.length === 0) return false;

    const selected = items.slice(0, limit);

    for (const item of selected) {
        await sendImageMessage(senderId, item.image_url, `Image ${productType} - ${item.title}`);
    }

    return true;
}

async function sendCarouselByProduct(senderId, productType) {
    // Ưu tiên gửi ảnh trực tiếp thay vì generic template/carousel,
    // vì một số app Page/Messenger hiển thị template là "Tin nhắn này không hiển thị".
    // Ảnh trực tiếp ổn định hơn khi tư vấn khách thật.
    return await sendImageGalleryByProduct(senderId, productType, 3);
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

    if (productType === "combo" || productType === "faucet" || productType === "kitchen_bath") {
        return "Dạ thiết bị vệ sinh bên em phân phối nhiều hãng như TOTO, INAX, Viglacera, Huge, Caesar... và có thương hiệu riêng GUKA. Anh cần xem hãng nào hoặc tầm giá nào ạ? Nếu tiện anh để lại SĐT/Zalo, chuyên viên sẽ gửi đúng mẫu và báo giá nhanh hơn ạ.";
    }

    if (productType === "kitchen") {
        return "Dạ thiết bị bếp bên em có nhiều thương hiệu và phân khúc khác nhau, ngoài ra có các mẫu phối đồng bộ theo nhu cầu. Anh cần xem nhóm bếp từ, hút mùi hay chậu vòi ạ? Nếu tiện anh để lại SĐT/Zalo để chuyên viên gửi đúng mẫu và báo giá nhanh hơn ạ.";
    }

    return "Dạ bên em phân phối nhiều thương hiệu lớn như TOTO, INAX, Viglacera, Huge, Caesar... và có thương hiệu riêng GUKA. Anh cần xem hãng nào hoặc tầm giá nào ạ?";
}

function isToiletOnlyQuestion(customerMessage) {
    const msg = String(customerMessage || "").toLowerCase();
    const toiletWords = ["bồn cầu", "bon cau", "bệt", "bet", "bồn vệ sinh", "bon ve sinh", "liền khối", "lien khoi"];
    const comboWords = ["combo", "phòng tắm", "phong tam", "nhà tắm", "nha tam", "thiết bị vệ sinh", "thiet bi ve sinh"];
    return toiletWords.some(word => msg.includes(word)) && !comboWords.some(word => msg.includes(word));
}

function buildToiletSampleFallback() {
    return "Dạ bồn vệ sinh bên em có nhiều mẫu liền khối và nhiều phân khúc, từ dòng tiết kiệm đến cao cấp. Hiện ảnh bồn cầu chưa gửi tự động ổn định trên Messenger, anh để lại SĐT/Zalo để chuyên viên gửi đúng mẫu, đúng giá và gọi tư vấn nhanh hơn ạ.";
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
        "lavabo", "sen", "vòi", "voi", "bồn", "bon", "combo", "tủ", "tu", "chậu", "chau",
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
    const recentLines = history.slice(-12);

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

    // Nếu app_id tồn tại nhưng không khớp text bot, vẫn không vội coi là admin.
    // Nhiều nền tảng tự động hóa cũng gắn app_id.
    if (event.message && event.message.app_id) {
        return true;
    }

    return false;
}

function startHumanTakeover(senderId, adminText, now) {
    const state = ensureCustomerState(senderId);

    state.humanTakeoverUntil = now + 10 * 60 * 1000;
    state.pendingHumanCustomer = false;
    state.lastAdminTime = now;

    clearHumanTakeoverTimer(senderId);

    conversations[senderId].push(`Admin: ${adminText || "[admin attachment/action]"} | TIME:${now} | PRODUCT:${state.currentTopic || "unknown"}`);
    conversations[senderId] = conversations[senderId].slice(-80);

    saveConversations(conversations);
    saveCustomerStates(customerStates);

    console.log("Human admin takeover detected and bot paused 10 minutes:", senderId, adminText);
}

async function handleMessage(event) {
    if (!event.message) return;

    const senderId = event.sender?.id || event.recipient?.id;
    if (!senderId) return;

    if (!conversations[senderId]) {
        conversations[senderId] = [];
    }

    const state = ensureCustomerState(senderId);
    const now = Date.now();

    // Nếu admin/page trả lời thủ công, webhook sẽ gửi echo.
    // Bot tự phân biệt echo của chính bot với echo của admin bằng app_id + nội dung gần nhất đã lưu.
    // Admin trả lời => bot dừng ngay 10 phút. Admin trả lời tiếp => reset lại 10 phút.
    if (event.message.is_echo) {
        if (!isOwnBotEcho(senderId, event)) {
            const echoText = getEchoTextFromEvent(event);
            startHumanTakeover(senderId, echoText, now);
        } else {
            console.log("Own bot echo ignored:", senderId);
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
    recordInternalMessageEvent({ event, senderId, pageId: event.recipient?.id, direction: "customer", text: customerMessage, state });

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

    // Nếu khách đã có SĐT/Zalo: không hỏi khai thác, không tư vấn lan man, chuyển chuyên viên.
    if (state.hasContact) {
        const reply = buildContactHandoverReply(customerMessage, state);
        conversations[senderId].push(`Bot: ${reply} | TIME:${Date.now()} | PRODUCT:${state.currentTopic || "unknown"} | HAS_CONTACT_HANDOVER`);
        conversations[senderId] = conversations[senderId].slice(-80);
        saveConversations(conversations);
        saveCustomerStates(customerStates);
        await sendMessage(senderId, reply);
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

    // Khách xin ảnh/mẫu/catalog: Text -> ảnh trực tiếp -> tin chốt xin SĐT/Zalo -> dừng.
    if (shouldSendCarousel(customerMessage)) {
        const productType = state.currentTopic || detectProductType(customerMessage, currentHistoryText);

        if (productType) {
            state.currentTopic = productType;
            state.productType = productType;
            state.lastCarouselTime = Date.now();
            saveCustomerStates(customerStates);

            const productRow = await findBestProductRow(productType, customerMessage, currentHistoryText);
            const intro = productRow ? buildProductIntroWithPrice(productRow, productType) : buildCarouselIntro(productType);
            await sendMessage(senderId, intro);
            conversations[senderId].push(`Bot: ${intro} | TIME:${Date.now()} | PRODUCT:${productType} | SHEET_INTRO`);

            const sent = await sendCarouselByProduct(senderId, productType);

            if (sent) {
                state.lastSampleTime = Date.now();
                state.lastCarouselTime = Date.now();
                state.stage = "GET_PHONE";
                state.sampleSentCount = Number(state.sampleSentCount || 0) + 1;
                state.carouselSent.push({ topic: productType, time: Date.now() });
                state.carouselSent = state.carouselSent.slice(-20);

                const close = buildCarouselClose(productType);
                await sendMessage(senderId, close);
                conversations[senderId].push(`Bot: ${close} | TIME:${Date.now()} | PRODUCT:${productType}`);
            } else {
                const fallback = "Dạ hiện em chưa gửi được ảnh trực tiếp trên Messenger. Anh để lại SĐT/Zalo, bên em gửi album mẫu và báo giá chi tiết cho anh ngay nhé?";
                await sendMessage(senderId, fallback);
                conversations[senderId].push(`Bot: ${fallback} | TIME:${Date.now()} | PRODUCT:${productType}`);
                state.lastCarouselTime = null;
            }

            conversations[senderId] = conversations[senderId].slice(-80);
            saveConversations(conversations);
            saveCustomerStates(customerStates);
            return;
        }
    }

    const history = conversations[senderId].slice(-30).join("\n");

    console.log("Calling OpenAI...");
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
                console.error("Error:", error);
                try {
                    if (event.sender && event.sender.id) {
                        await sendMessage(
                            event.sender.id,
                            "Dạ hiện hệ thống tư vấn tự động đang bận một chút. Anh nhắn lại sản phẩm cần xem, bên em hỗ trợ ngay ạ."
                        );
                    }
                } catch (sendError) {
                    console.error("Fallback send error:", sendError);
                }
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
        ad_ids: pancakeExtractAdIds(conv)
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
        const totalMessages = source === "pancake"
            ? Number(pancake.total || 0)
            : Math.max(Number(direct.total || 0), metaMessages);
        byDate[day] = {
            date: day,
            spend: Number(metaDaily?.byDate?.[day] || 0),
            accountSpendText: dashboardFormatAccountSpendList(accounts),
            accounts,
            total: totalMessages,
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

function dashboardBuildAdStats(report, metaData, supplementalReport = []) {
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

    // Map hội thoại vào những QC đang có spend.
    // 3.9.1: dùng cả nguồn đang xem và Pancake bổ sung để tránh tình trạng Meta Direct chưa lưu đủ ad_id/SĐT.
    const mergedItems = [];
    const seenLeadKeys = new Set();
    for (const item of [...(report || []), ...(supplementalReport || [])]) {
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
        row.total++;
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
        // Nếu Pancake/Webhook chưa map được lead theo ad_id, vẫn hiển thị số tin nhắn từ Meta Insights.
        // SĐT/Zalo vẫn lấy từ dữ liệu hội thoại khi có.
        row.total = Math.max(Number(row.total || 0), Number(row.metaMessages || 0));
        row.noPhone = Math.max(0, Number(row.total || 0) - Number(row.hasPhone || 0));
    }

    return Object.values(map).sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
}

function dashboardRenderHtml({ title, limit, fullTotal, report, req, mode, pancakeMeta, metaData, dateRange, dataSource = "meta", compareStats = null, pancakeReport = [] }) {
    const stats = dashboardBuildStats(report);
    const adsStats = dashboardBuildAdStats(report, metaData, dataSource === "pancake" ? [] : pancakeReport);
    const currentLimit = String(limit || 500);
    const currentProduct = dashboardProductParamFromName(dashboardNormalizeProduct(req.query.product || "all"));
    const currentView = dashboardGetViewValue(req, mode);
    const currentDate = req.query.date || (dateRange.basis === "meta" ? dashboardTodayKeyMeta(0) : dashboardTodayKeyVN(0));
    const currentTimeBasis = dateRange.basis || "pancake";
    const currentDataSource = String(dataSource || req.query.data_source || "meta");
    const totalSpend = Number(metaData?.totalSpend || 0);
    const totalAdConversations = adsStats.reduce((sum, x) => sum + Number(x.total || 0), 0);
    const totalAdPhones = adsStats.reduce((sum, x) => sum + Number(x.hasPhone || 0), 0);
    const totalCostPerConversation = dashboardCost(totalSpend, totalAdConversations || stats.total);
    const totalCostPerPhone = dashboardCost(totalSpend, totalAdPhones || stats.hasPhone);
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
        ? `<div class="notice green-note">${sourceBadge}<b>Đang xem dữ liệu Meta trực tiếp.</b> Dữ liệu lấy từ kho Webhook nội bộ, không giới hạn 100/300/500 hội thoại.</div>`
        : currentDataSource === "compare"
            ? `<div class="notice">${sourceBadge}<b>Đang so sánh hai nguồn.</b> Meta lấy toàn bộ dữ liệu nội bộ theo khoảng ngày; giới hạn 100/300/500 chỉ áp dụng cho Pancake.</div>`
            : `<div class="notice">${sourceBadge}<b>Đang xem dữ liệu Pancake.</b> Giới hạn hội thoại Pancake áp dụng theo lựa chọn 100/300/500.</div>`;

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
            <td><b>${dashboardEscapeHtml(x.phones.join(", ") || "Có số nhưng chưa đọc được số")}</b></td>
            <td>${dashboardEscapeHtml(x.product)}</td>
            <td>${dashboardEscapeHtml(dashboardFormatTags(x.tags))}</td>
        </tr>
    `).join("");

    const noPhoneRows = report.filter(x => !x.has_phone).slice(0, 50).map((x, index) => `
        <tr class="row-normal">
            <td>${index + 1}</td>
            <td><b>${dashboardEscapeHtml(x.name)}</b><br><span>${dashboardEscapeHtml(x.conversation_id)}</span></td>
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
    <title>AIGUKA Dashboard 3.9.1</title>
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
            <h1>🤖 AIGUKA AI SALES DASHBOARD 3.8</h1>
            <p>${dashboardEscapeHtml(title)} | Đã lấy ${fullTotal}/${limit} hội thoại | Đang hiển thị ${stats.total} hội thoại | Cập nhật: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
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
        <div class="card blue"><div class="label">Hội thoại từ QC có spend</div><div class="num">${totalAdConversations}</div></div>
        <div class="card green"><div class="label">SĐT từ QC có spend</div><div class="num">${totalAdPhones}</div></div>
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
    <div class="section"><h2>🔥 Khách nóng chưa có số</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Khách</th><th>Sản phẩm</th><th>Tags</th><th>Cập nhật</th><th>Nội dung gần nhất</th></tr></thead><tbody>${hotRows || `<tr><td colspan="6">Không có</td></tr>`}</tbody></table></div></div>
    <div class="section"><h2>📞 Khách đã có số</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Khách</th><th>Số điện thoại</th><th>Sản phẩm</th><th>Tags</th></tr></thead><tbody>${phoneRows || `<tr><td colspan="5">Không có</td></tr>`}</tbody></table></div></div>
    <div class="section"><h2>🕒 Khách chưa có số gần nhất</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Khách</th><th>Sản phẩm</th><th>Tags</th><th>Cập nhật</th><th>Nội dung gần nhất</th></tr></thead><tbody>${noPhoneRows || `<tr><td colspan="6">Không có</td></tr>`}</tbody></table></div></div>
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
        res.type('html').send(dashboardRenderHtml({
            title: filtered.title,
            limit,
            fullTotal: fullReport.length,
            report: filtered.report,
            req,
            mode,
            pancakeMeta: pancakeResult,
            metaData,
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
    // Rà 1 lần khi máy chủ online lại.
    // Chỉ gửi nếu khách im 12-20h, chưa có số/Zalo, đã nhắn >= 2 tin, xác định được đúng sản phẩm, và chưa từng chăm sóc.
    setTimeout(() => {
        checkFollowUpsOnStart().catch(console.error);
    }, 5000);

    // Khi server còn online, kiểm tra lại mỗi 2 giờ để giảm tần suất tự động.
    setInterval(() => {
        checkFollowUpsOnStart().catch(console.error);
    }, 2 * 60 * 60 * 1000);
}

module.exports = {
    app,
    startBackgroundJobs
};
