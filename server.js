const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const HISTORY_FILE = path.join(__dirname, 'conversations.json');
const STATE_FILE = path.join(__dirname, 'customer_states.json');

function loadConversations() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
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
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
        customerStates[senderId] = {
            productType: null,
            lastCustomerTime: null,
            hasContact: false,
            followUp8hSent: false,
            lastFollowUpTime: null
        };
    }

    return customerStates[senderId];
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
        normalized.includes("đã cho số") ||
        normalized.includes("đã để lại số")
    ) {
        return true;
    }

    return false;
}

function buildFollowUpMessage(productType) {
    if (productType === "fan") {
        return "Dạ em nhắn lại về mẫu quạt anh xem lúc trước ạ. Bên em còn nhiều mẫu quạt phù hợp theo diện tích phòng và ngân sách khác nhau. Anh muốn em lọc thêm mẫu theo phòng bao nhiêu m2 để gửi đúng hơn không ạ?";
    }

    if (productType === "faucet") {
        return "Dạ em nhắn lại về nhóm sen vòi, lavabo, chậu rửa anh xem lúc trước ạ. Bên em còn nhiều mẫu phối đồng bộ cho phòng tắm. Anh muốn xem thêm dòng cơ bản hay dòng đẹp hơn một chút ạ?";
    }

    if (productType === "combo") {
        return "Dạ em nhắn lại về mẫu thiết bị vệ sinh/phòng tắm anh xem lúc trước ạ. Bên em có combo cơ bản, trung cấp và cao cấp, có thể phối theo ngân sách. Anh muốn em gửi thêm nhóm mẫu tầm bao nhiêu tiền ạ?";
    }

    return null;
}

async function checkFollowUpsOnStart() {
    console.log("Checking 8h follow-ups...");

    const now = Date.now();
    const minDelay = 8 * 60 * 60 * 1000;
    const maxDelay = 23 * 60 * 60 * 1000;

    for (const senderId of Object.keys(conversations)) {
        try {
            const history = conversations[senderId];

            if (!Array.isArray(history) || history.length === 0) continue;

            const state = ensureCustomerState(senderId);
            const historyText = history.join(" ").toLowerCase();

            if (state.hasContact || hasPhoneOrContact(historyText)) {
                state.hasContact = true;
                saveCustomerStates(customerStates);
                continue;
            }

            if (state.followUp8hSent) continue;
            if (!state.lastCustomerTime) continue;

            const diff = now - Number(state.lastCustomerTime);

            // Chỉ chăm sóc trong cửa sổ 8h-23h để tránh vượt quá chính sách 24h của Messenger
            if (diff < minDelay || diff > maxDelay) continue;

            // Tuyệt đối chống nhầm chủ đề: nếu không xác định được chủ đề thì bỏ qua, không gửi đại
            if (!state.productType) {
                const detectedFromHistory = detectProductType("", historyText);
                if (detectedFromHistory) {
                    state.productType = detectedFromHistory;
                } else {
                    console.log("Skip follow-up, unknown product type:", senderId);
                    continue;
                }
            }

            const followText = buildFollowUpMessage(state.productType);
            if (!followText) {
                console.log("Skip follow-up, no follow-up message for type:", senderId, state.productType);
                continue;
            }

            await sendMessage(senderId, followText);

            history.push(`Bot chăm sóc 8h (${state.productType}): ${followText} | TIME:${now} | PRODUCT:${state.productType}`);
            conversations[senderId] = history.slice(-60);

            state.followUp8hSent = true;
            state.lastFollowUpTime = now;

            saveConversations(conversations);
            saveCustomerStates(customerStates);

            console.log("8h follow-up sent:", senderId, state.productType);
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

app.get('/', (req, res) => {
    res.send('Server OK');
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
    const msg = customerMessage.toLowerCase();

    // Không dùng từ đơn "ảnh" hoặc "anh", vì "anh" sẽ làm bot gửi slide nhầm ở hầu hết hội thoại.
    const words = [
        "gửi ảnh", "gui anh",
        "xin ảnh", "xin anh",
        "xem ảnh", "xem anh",
        "cho ảnh", "cho anh",
        "xem mẫu", "xem mau",
        "cho xem", "gửi mẫu", "gui mau",
        "xin mẫu", "xin mau",
        "cho mẫu", "cho mau"
    ];

    return words.some(word => msg.includes(word));
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

COMBO / THIẾT BỊ:
- Combo có loại phối sẵn và loại tự chọn theo nhu cầu.
- Thiết bị vệ sinh, phòng tắm, gạch đá, nội thất nên mời khách qua showroom xem thực tế.
- Có hỗ trợ chi phí khách đến showroom theo chương trình.
- Có hỗ trợ vận chuyển khi mua hàng theo chính sách.

QUY TẮC:
- Ưu tiên tư vấn có giá trị trước.
- Khách hỏi giá, xin mẫu, xin thông tin thì có thể xin số điện thoại/Zalo, nhưng nếu khách muốn xem trên Messenger thì tư vấn trên Messenger trước.
- Nếu khách nói "gửi qua đây", "xem trên này", "cho xem ảnh" thì nói sẽ gửi mẫu bên dưới, rồi dựng lên vấn đề như đó như nhắn trên messenger dễ bị trôi tin do tin nhắn quảng cáo nhiều, hoặc hạn chế, xem thêm nhiều hơn ảnh video rõ nét hơn thì gửi zalo..
- Không bịa giá chính xác nếu chưa có bảng giá.
- Không tư vấn sâu khi khách chưa cho số điện thoại hoặc zalo, chỉ cần khách trả lời thông tin tư vấn 2 hoặc 3 câu là xin số điện thoại/Zalo để tư vấn chi tiết hơn.
- Nếu khách nhắn tin ký tự khó hiểu, không dịch được hoặc phàn nàn chất lượng ảnh, video, thông tin thì không cần xin lỗi và hỏi lại vấn đề gì hay cần hỗ trợ gì, xin số điện thoại/zalo gọi điện trực tiếp cho tiện
- Tối đa 4 câu, tối đa 80 từ.
- Quy tắc sau khi gửi ảnh, video hoặc slide đều phải nói thêm rằng đây là một số mẫu bán chạy để khách tham khảo, còn rất nhiều mẫu nữa, do hạn chế tin nhắn Quảng cáo chỉ gửi được vậy, nếu muốn xem thêm, tư vấn chi tiết hơn hoặc xem thêm mẫu thì có thể liên hệ qua Zalo hoặc gọi điện để được hỗ trợ tốt nhất, có thể xin sdt zalo để tư vấn và gửi thêm luôn,tránh tình trạng khách chỉ xem ảnh rồi không phản hồi lại nữa.
- Luôn kết thúc bằng câu hỏi tự nhiên.

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
            title: "Combo cơ bản 4-6 triệu 01",
            subtitle: "Phù hợp phòng tắm phổ thông, tiết kiệm chi phí",
            image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/721841502_3407023772807451_2219495493695105387_n.jpg?stp=dst-webp_fr_q75&_nc_cat=104&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeFmFpWydFScpHjZfZGIegsMnheWmvwORraeF5aa_A5Gtshvo5X27hDJxdHeib2fiKmaVuK0QZQfMqNZl0IwaXn2&_nc_ohc=1_7eDbD6dxgQ7kNvwEKcNjN&_nc_oc=AdqWd_2C8PLDr7llHjd9sGmu9MfMK4qRr9DjS4kS_mUXqSqO3nhkLgXMt6-CYgUr-qE&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af_yyrtvN6FYDEdWkds0WvrlBjF-MVk9K_EDfDjDCLH7MQ&oe=6A3F173F",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo cơ bản 4-6 triệu 02",
            subtitle: "Bộ phối sẵn, dễ lắp cho nhà mới",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/722363580_3407023566140805_6501584263051580923_n.jpg?stp=dst-webp_fr_q75&_nc_cat=111&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeFEEDG4i_WZ3FH8vERm_CT9M5ipV4CTLbYzmKlXgJMttnzTbZCsqhs984KgokKVm6LjzjW37p8bQBAmkuJgfaDV&_nc_ohc=P9N9qhDfw9gQ7kNvwGGjL3Z&_nc_oc=AdquXFo1OQfPJBT_9QY64KWMvMVHMGEqVAGZB0JcXSNo5YMHFPQ2A7s1YQD4by8rQwg&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af-GqPMTnXFrpe8kYFE60q09ZyiiqjW30sc2OAtm4MtXBA&oe=6A3F041C",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo cơ bản 4-6 triệu 03",
            subtitle: "Phù hợp căn hộ, nhà phố, phòng tắm nhỏ",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/722030414_3407023492807479_4272071537859353682_n.jpg?stp=dst-webp_fr_q75&_nc_cat=106&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEmWeC1VuHVVVPp2hWnGLOBH-h6fWPlTiUf6Hp9Y-VOJRKRGRjd3lbPUfl8IbbxcPJaHU6Z5ay2kWWkxKj68GWp&_nc_ohc=kG52JQwmI_gQ7kNvwG7w7Ly&_nc_oc=AdqaL5jaCh6XbOhVblfxC9NqVPdEZwZ0at5NMNCbf937lrKulDS2c128fEmk039k6vE&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=u-xhVRGH8O-Wqel_CNFKtw&_nc_ss=7b2a8&oh=00_Af-hIP9YYe_Dwst8bucrNct7NYI9c5rDKuQjiwvtvX2-Xg&oe=6A3F1D71",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo cơ bản 4-6 triệu 04",
            subtitle: "Mẫu tiết kiệm, đủ thiết bị cần dùng",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/723543437_3407023759474119_1152871356518316127_n.jpg?stp=dst-webp_fr_q75&_nc_cat=111&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHjHywu1goJoj4rcll7hF37F6gpfTctLaEXqCl9Ny0toRGp962s0cVTTIr0NxT6TtxgdcxzKY3qFS-de1IOZ3Pc&_nc_ohc=yzwCTaZRhFoQ7kNvwFNMXx0&_nc_oc=AdrhhhdBk_Z8t-wD3PfAlHk-sQO36rpf2BLfKg5HMbSXZOqBJRDIn0kR2_0suDtS2W4&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af9LJOhU0JTA5oIbQWPKKxh1X4HkMFU8tHIm586YJbZHlQ&oe=6A3EFAE4",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo cơ bản 4-6 triệu 05",
            subtitle: "Giá tốt, phù hợp công trình số lượng",
            image_url: "https://scontent.fhan5-6.fna.fbcdn.net/v/t45.1600-4/722097598_3407023746140787_3094052314991038689_n.jpg?stp=dst-webp_fr_q75&_nc_cat=107&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEx-5JrjhDSW5WKTJ1O3Twutqkpy-DlegK2qSnL4OV6AoFZyLk67lU7xkXXNbOkpQK4XSCoXhWvqwK1eFRwjraQ&_nc_ohc=wXzQyGT8RYUQ7kNvwF7im1p&_nc_oc=AdoQXbeF_59hTALN9pqt3PjDyLLUZQnPY_C2Upb-p8zQaT48TZ82CH6RRFlTS6MMDgE&_nc_zt=1&_nc_ht=scontent.fhan5-6.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af9IyJ9xVEqOPZ_cAhrl1ku_fen6k4TQuRawdK0U1aOTBQ&oe=6A3F06D5",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo đẹp 6-9 triệu 01",
            subtitle: "Mẫu đẹp hơn, phối đồng bộ",
            image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/724414534_3407023669474128_6654698488176819038_n.jpg?stp=dst-webp_fr_q75&_nc_cat=101&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHACvlu0KvhLkjXOnnf6bOw9_sCnHDN9e_3-wKccM317-sN6_nRJrk0WbCMlpYG3AEXlLniBnW1DHIgvHDYTaA9&_nc_ohc=6WemwsdtinoQ7kNvwHVRB0a&_nc_oc=AdouwRUdoydBWrxsA-QQphXYGoL9DvO5Dmd282j-5hvGZfg931KjXi_KohvZa7l98xo&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=u-xhVRGH8O-Wqel_CNFKtw&_nc_ss=7b2a8&oh=00_Af_IKdEht3IyCtadRcq8idmCtJvhSh3JyPCFWa7WpOHD0A&oe=6A3F0FE9",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo đẹp 6-9 triệu 02",
            subtitle: "Phù hợp nhà mới, căn hộ, nhà phố",
            image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/722074589_3407023709474124_2192680801667191676_n.jpg?stp=dst-webp_q70_s168x128&_nc_cat=106&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHnJ4k5B5lRET3XAU3IPYL2lLixa3kR35iUuLFreRHfmBxFcboZ3Cl35HcZb3SOT8N_gbiSz12TSecGCUu2IgPZ&_nc_ohc=X2qJ337q3QoQ7kNvwFZ426G&_nc_oc=AdrRVW6WYH-4TPLjnU5c1AcNrGo2_VNOmO5AWLSkZ8saz82SOj8ejLK34daenXCnTLY&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=78RevIFYinNeeYQnD38J7Q&_nc_ss=7b2a8&oh=00_Af-vCD6REiM1VxHEJx1qwJVUUQdJScbaY5NpudcKmoFzMQ&oe=6A3EFDE6",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo đẹp 6-9 triệu 03",
            subtitle: "Tối ưu chi phí nhưng vẫn đẹp",
            image_url: "https://scontent.fhan5-11.fna.fbcdn.net/v/t45.1600-4/724838572_3407023849474110_3761190961699111613_n.jpg?stp=dst-webp_fr_q75&_nc_cat=103&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeEBRp7MplN8IqeHtPW6sC9PLTJcoG2ETS8tMlygbYRNL_r4u33rUMAjUqx3XVZCLnqzjBEfD9tWLxapY3b_fP0X&_nc_ohc=hmY84XaNO2EQ7kNvwGiYilH&_nc_oc=AdpOCfh0StWrmOjOF9COuqjsUU_q1LMuB33FUQxNm-vUh9EfAlyyk22rzTywbz3Fegc&_nc_zt=1&_nc_ht=scontent.fhan5-11.fna&_nc_gid=78RevIFYinNeeYQnD38J7Q&_nc_ss=7b2a8&oh=00_Af95Zz0PsNelB4Xo01bTvmacncpJ-2Mzbg4rDDWctzBAWw&oe=6A3EF4E1",
            buttons: [{ type: "phone_number", title: "Gọi tư vấn", payload: "0973693677" }]
        },
        {
            title: "Combo cao cấp 10 triệu+",
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

async function handleMessage(event) {
    if (!event.message || !event.message.text) return;
    if (event.message.is_echo) return;

    const messageId = event.message.mid;
    if (processedMessages.has(messageId)) {
        console.log("Duplicate message ignored:", messageId);
        return;
    }
    processedMessages.add(messageId);

    const senderId = event.sender.id;
    const customerMessage = event.message.text;
    const now = Date.now();

    console.log("Customer ID:", senderId);
    console.log("Customer Message:", customerMessage);

    if (!conversations[senderId]) {
        conversations[senderId] = [];
    }

    const state = ensureCustomerState(senderId);
    const currentHistoryText = conversations[senderId].slice(-30).join(" ");
    const detectedType = detectProductType(customerMessage, currentHistoryText);

    if (detectedType) {
        state.productType = detectedType;
    }

    state.lastCustomerTime = now;
    state.followUp8hSent = false;

    if (hasPhoneOrContact(customerMessage)) {
        state.hasContact = true;
    }

    conversations[senderId].push(`Khách: ${customerMessage} | TIME:${now} | PRODUCT:${state.productType || "unknown"}`);
    conversations[senderId] = conversations[senderId].slice(-60);

    saveConversations(conversations);
    saveCustomerStates(customerStates);

    const history = conversations[senderId].slice(-30).join("\n");

    console.log("Calling OpenAI...");
    const aiReply = await getAIReply(history);

    conversations[senderId].push(`Bot: ${aiReply} | TIME:${Date.now()} | PRODUCT:${state.productType || "unknown"}`);
    conversations[senderId] = conversations[senderId].slice(-60);

    saveConversations(conversations);
    saveCustomerStates(customerStates);

    console.log("AI Reply:", aiReply);
    await sendMessage(senderId, aiReply);

    if (shouldSendCarousel(customerMessage)) {
        const updatedHistory = conversations[senderId].slice(-30).join(" ");
        const productType = detectProductType(customerMessage, updatedHistory) || state.productType;

        if (productType === "combo") {
            await sendComboCarousel(senderId);
        } else if (productType === "fan") {
            await sendFanCarousel(senderId);
        } else if (productType === "faucet") {
            await sendFaucetCarousel(senderId);
        } else {
            console.log("Carousel skipped, unknown product type:", senderId, customerMessage);
        }
    }
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

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);

    // Khi máy chủ online lại, rà khách im 8-23 tiếng, chưa có số điện thoại/Zalo và chăm sóc đúng chủ đề
    setTimeout(() => {
        checkFollowUpsOnStart().catch(console.error);
    }, 5000);

    // Khi server còn online, kiểm tra lại mỗi 60 phút
    setInterval(() => {
        checkFollowUpsOnStart().catch(console.error);
    }, 60 * 60 * 1000);
});
