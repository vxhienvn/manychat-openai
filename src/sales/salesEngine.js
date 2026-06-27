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
    if (["bon cau", "bon ve sinh", "bet", "toilet", "wc", "bon tam", "lavabo", "bon rua mat", "chau lavabo"].some(w => msg.includes(w))) return false;
    return /^(bon|bon nay|bon kia|bon do|bon gia|bon bao nhieu|bon nay bao nhieu|bồn|bồn này|bồn kia|bồn đó)$/i.test(raw) || /^(bon|bồn)\s+(nay|này|kia|do|đó|gia|giá|bn|bao nhieu|bao nhiêu)(\s|$)/i.test(raw);
}

function detectExplicitTopic(message) {
    const msg = normalizeIntentText(message || "");

    if (isAmbiguousBonQuery(message)) return null;

    const toiletWords = ["bon cau", "bon cau thong minh", "bon cau ai", "cau thong minh", "bon ve sinh", "bet", "toilet", "wc", "lien khoi", "uv", "khu khuan", "dieu khien giong noi"];
    if (toiletWords.some(word => msg.includes(word))) return "toilet";

    const fanWords = [
        "quạt", "quat", "quạt trần", "quat tran", "quạt đèn", "quat den",
        "guka", "5 cánh", "5 canh", "8 cánh", "8 canh", "10 cánh", "10 canh",
        "55w", "65w", "70w", "90w", "đèn không", "den khong", "đèn nhẹ", "den nhe",
        "không lòe", "khong loe"
    ];

    const kitchenWords = [
        "bếp", "bep", "thiết bị bếp", "thiet bi bep",
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
    if (productType === "toilet") {
        return "Dạ bồn cầu thông minh bên em có nhiều mẫu từ phổ thông đến cao cấp. Anh/chị cho em xin SĐT/Zalo để chuyên viên gửi mẫu đúng nhu cầu và báo giá nhanh ạ.";
    }

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


function normalizeText(text = "") {
    return String(text || "").toLowerCase();
}

function detectIntent(customerMessage) {
    const msg = normalizeText(customerMessage);

    if (hasPhoneOrContact(msg)) return "CONTACT_PROVIDED";

    if (
        msg.includes("gửi mẫu") || msg.includes("gui mau") ||
        msg.includes("xem mẫu") || msg.includes("xem mau") ||
        msg.includes("cho xem") || msg.includes("gửi ảnh") || msg.includes("gui anh") ||
        msg.includes("xem ảnh") || msg.includes("xem anh") ||
        msg.includes("hình") || msg.includes("hinh") ||
        msg.includes("album") || msg.includes("catalog") || msg.includes("catalogue") ||
        msg.includes("tham khảo") || msg.includes("tham khao")
    ) return "SAMPLE_REQUEST";

    if (
        msg.includes("giá") || msg.includes("gia") ||
        msg.includes("bao nhiêu") || msg.includes("bao nhieu") ||
        msg.includes("báo giá") || msg.includes("bao gia") ||
        msg.includes("xin giá") || msg.includes("xin gia")
    ) return "PRICE_REQUEST";

    if (
        msg.includes("địa chỉ") || msg.includes("dia chi") ||
        msg.includes("ở đâu") || msg.includes("o dau") ||
        msg.includes("showroom") || msg.includes("cửa hàng") || msg.includes("cua hang")
    ) return "SHOWROOM_REQUEST";

    return "GENERAL";
}

function buildSampleIntro(productType) {
    if (productType === "toilet") {
        return "Dạ bồn cầu thông minh bên em có nhiều dòng AI, cảm ứng tự mở nắp, tự xả, tự phun rửa, sấy khô, UV khử khuẩn và điều khiển giọng nói. Anh/chị để lại SĐT/Zalo để bên em gửi đúng mẫu kèm khoảng giá ạ.";
    }

    if (productType === "fan") {
        return "Dạ em gửi anh một số mẫu quạt bán chạy bên dưới để anh tham khảo nhé.";
    }
    if (productType === "faucet") {
        return "Dạ em gửi anh một số mẫu sen vòi, lavabo, chậu rửa bên dưới để anh tham khảo nhé.";
    }
    if (productType === "combo") {
        return "Dạ em gửi anh một số mẫu combo phòng tắm bán chạy bên dưới để anh tham khảo nhé.";
    }
    if (productType === "kitchen") {
        return "Dạ em gửi anh một số mẫu thiết bị bếp, chậu rửa, vòi bếp bên dưới để anh tham khảo nhé.";
    }
    if (productType === "kitchen_bath") {
        return "Dạ em gửi anh một số mẫu cho cả khu bếp và phòng tắm bên dưới để anh tham khảo nhé.";
    }
    return "Dạ em gửi anh một số mẫu bán chạy bên dưới để anh tham khảo nhé.";
}

function buildAfterSamplePhoneAsk(productType) {
    if (productType === "kitchen_bath") {
        return "Bên em còn nhiều mẫu phối đồng bộ bếp và phòng tắm hơn nữa. Anh cho em xin số Zalo hoặc số điện thoại, em gửi album đầy đủ và báo giá chi tiết từng bộ ạ.";
    }
    if (productType === "fan") {
        return "Anh thích mẫu nào hoặc cần theo diện tích phòng bao nhiêu m2 ạ? Anh cho em xin số Zalo/điện thoại, em gửi thêm mẫu thực tế và báo giá chi tiết ạ.";
    }
    return "Anh xem mẫu nào phù hợp thì nhắn em nhé. Anh cho em xin số Zalo hoặc số điện thoại, em gửi album đầy đủ và báo giá chi tiết từng mẫu ạ.";
}

function shouldBypassAI(intent) {
    return intent === "SAMPLE_REQUEST" || intent === "SHOWROOM_REQUEST";
}

module.exports = {
    hasPhoneOrContact,
    buildFollowUpMessage,
    detectProductType,
    shouldSendCarousel,
    detectExplicitTopic,
    isDontCallMessage,
    buildDontCallReply,
    buildCarouselIntro,
    buildCarouselClose,
    getCustomerMessageFromEvent,
    normalizeText,
    detectIntent,
    buildSampleIntro,
    buildAfterSamplePhoneAsk,
    shouldBypassAI,
    isAmbiguousBonQuery,
    normalizeIntentText
};
