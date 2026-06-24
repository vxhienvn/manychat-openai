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

    return null;
}

function detectProductType(customerMessage, historyText) {
    const msg = (customerMessage || "").toLowerCase();
    const history = (historyText || "").toLowerCase();
    const combined = `${msg} ${history}`;

    const faucetWords = [
        "lavabo", "chậu lavabo", "chau lavabo",
        "sen", "sen tắm", "sen tam",
        "vòi", "voi", "vòi rửa", "voi rua",
        "chậu rửa", "chau rua"
    ];

    const bathWords = [
        "combo", "phòng tắm", "phong tam", "nhà tắm", "nha tam",
        "nhà vệ sinh", "nha ve sinh", "thiết bị vệ sinh", "thiet bi ve sinh",
        "bồn cầu", "bon cau", "bồn tắm", "bon tam", "bếp", "bep", "gạch", "gach"
    ];

    const fanWords = [
        "quạt", "quat", "quạt trần", "quat tran", "quạt đèn", "quat den",
        "5 cánh", "8 cánh", "10 cánh", "55w", "65w", "70w", "90w",
        "cho xem quạt", "xem quạt", "gửi quạt", "gui quat", "xin quạt", "xin quat"
    ];

    // Ưu tiên tin nhắn mới trước để khách đổi chủ đề vẫn đúng
    if (faucetWords.some(word => msg.includes(word))) return "faucet";
    if (bathWords.some(word => msg.includes(word))) return "combo";
    if (fanWords.some(word => msg.includes(word))) return "fan";

    const askImageWords = [
        "gửi ảnh", "gui anh", "xin ảnh", "xin anh",
        "xem ảnh", "xem anh", "cho ảnh", "cho anh",
        "xem mẫu", "xem mau", "cho xem", "gửi mẫu", "gui mau",
        "xin mẫu", "xin mau", "cho mẫu", "cho mau", "xem"
    ];

    const isAskingImage = askImageWords.some(word => msg.includes(word));

    if (isAskingImage || !msg.trim()) {
        if (faucetWords.some(word => history.includes(word))) return "faucet";
        if (bathWords.some(word => history.includes(word))) return "combo";
        if (fanWords.some(word => history.includes(word))) return "fan";
    }

    if (faucetWords.some(word => combined.includes(word))) return "faucet";
    if (bathWords.some(word => combined.includes(word))) return "combo";
    if (fanWords.some(word => combined.includes(word))) return "fan";

    return null;
}

function shouldSendCarousel(customerMessage) {
    const msg = (customerMessage || "").toLowerCase();

    // Gửi carousel khi khách hỏi mẫu/ảnh/giá của một nhóm sản phẩm cụ thể.
    // Không dùng từ đơn "anh" vì dễ nhầm với đại từ xưng hô.
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
        "mẫu quạt", "mau quat",
        "mẫu 8 cánh", "mau 8 canh",
        "mẫu 10 cánh", "mau 10 canh",
        "xin giá", "xin gia",
        "báo giá", "bao gia",
        "giá quạt", "gia quat",
        "giá mẫu", "gia mau",
        "giá này", "gia nay",
        "quạt này", "quat nay",
        "8 cánh", "8 canh",
        "10 cánh", "10 canh",
        "combo này", "combo nay",

        // Các câu khách hay dùng khi muốn xem mẫu/hình nhưng không nói đúng từ khóa cũ
        "mẫu", "mau",
        "mẫu nào", "mau nao",
        "mẫu đẹp", "mau dep",
        "mẫu khác", "mau khac",
        "có mẫu khác", "co mau khac",
        "xem thêm", "xem them",
        "xem thêm mẫu", "xem them mau",
        "tham khảo", "tham khao",
        "catalog", "catalogue",
        "hình", "hinh",
        "hình thật", "hinh that",
        "ảnh thật", "anh that",
        "hình thực tế", "hinh thuc te",
        "ảnh thực tế", "anh thuc te",

        // Khi khách gửi ảnh/tệp, getCustomerMessageFromEvent sẽ tạo câu này
        "khách vừa gửi", "khach vua gui",
        "cần tư vấn mẫu này", "can tu van mau nay"
    ];

    return words.some(word => msg.includes(word));
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
    getCustomerMessageFromEvent,
    normalizeText,
    detectIntent,
    buildSampleIntro,
    buildAfterSamplePhoneAsk,
    shouldBypassAI
};
