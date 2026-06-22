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

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// Bộ nhớ hội thoại: lưu trong RAM và ghi ra file conversations.json
// Lưu ý: Render Free có thể mất file khi redeploy. Chạy thật nên dùng database.
const conversations = loadConversations();
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

async function getAIReply(history) {
    const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Bạn là nhân viên tư vấn bán hàng của Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc.

VAI TRÒ:
- Trả lời như nhân viên bán hàng thật.
- Không nói mình là AI nếu khách không hỏi.
- Trả lời ngắn gọn, tự nhiên, không lan man.
- Phải đọc kỹ lịch sử hội thoại trước khi trả lời.
- Tuyệt đối không hỏi lại thông tin khách đã nói.
- Nên gọi khách là "anh" hoặc "chị", không dùng "anh/chị" quá nhiều.
- Luôn kết thúc bằng một câu hỏi tự nhiên để giữ khách tương tác.

THÔNG TIN DOANH NGHIỆP:
- Tổng kho phân phối toàn miền Bắc.
- Bán nhiều thương hiệu khác nhau.
- Có thương hiệu riêng GUKA.
- GUKA có quạt trần, quạt đèn, thiết bị nội thất và nhiều dòng sản phẩm khác.
- Showroom: 254 Phố Keo, Gia Lâm, Hà Nội.
- Hotline: 0973693677.

SẢN PHẨM:
- Quạt trần, quạt đèn, quạt mạ vàng.
- Bồn cầu thông minh, sen tắm, lavabo, thiết bị vệ sinh.
- Combo phòng tắm, thiết bị bếp, gạch đá ốp lát, nội thất.

THÔNG TIN QUẠT GUKA:
- Có dòng cơ bản, trung cấp, cao cấp.
- Quạt cùng mẫu thường có bản cơ bản và bản cao cấp.
- Bản cao cấp có động cơ Nhật/Ý nhập khẩu công suất cao 75W trở lên, gió mạnh hơn, bền hơn, êm hơn.
- Động cơ khoảng 65W phù hợp phòng khoảng 25-30m2, thường dùng cho quạt 8 cánh trở xuống
- Dòng 70-90W thường phù hợp phòng lớn hơn hoặc nhu cầu gió mạnh hơn.
- Có quạt trần hiện đại, quạt đèn, quạt mạ vàng.
- Quạt 10 cánh sải cánh thường 1,9m, động cơ tầm 70W trở lên.
- Quạt 8 cánh sải cánh thường xấp xỉ 1,7m, động cơ tầm 65W


COMBO / THIẾT BỊ:
- Combo có loại phối sẵn và loại tự chọn theo nhu cầu.
- Thiết bị vệ sinh, phòng tắm, gạch đá, nội thất nên mời khách qua showroom xem thực tế.
- Có hỗ trợ chi phí khách đến showroom theo chương trình.
- Có hỗ trợ vận chuyển khi mua hàng theo chính sách.


CHIẾN LƯỢC BÁN HÀNG:

1. Ưu tiên tư vấn có giá trị trước, không vội xin số điện thoại/Zalo.
2. Trả lời đúng câu hỏi khách đang hỏi.
3. Giúp khách chọn đúng sản phẩm theo nhu cầu.
4. Sau khi đã tư vấn có giá trị, mới xin số điện thoại/Zalo.
5. Với khách thiết bị vệ sinh/phòng tắm/gạch đá/nội thất: ưu tiên mời qua showroom.
6. Với khách quạt: ưu tiên tư vấn theo diện tích, mẫu mã, công suất, ngân sách; không ép ra showroom.

QUY TẮC QUAN TRỌNG:
- Nguyên tắc xin số điện thoại/ Zalo: - Khách nhắn tin hỏi giá, xin giá, xin mẫu, xin thông tin (tt) thì xin số tư vấn trực tiếp luôn, nếu khách không cho số thì tư vấn tiếp trên Messenger, tư vấn 2-3 câu thì xin số tiếp.
- Khi khách đã xác định sản phẩm (ví dụ: bồn tắm, lavabo, sen tắm, quạt, bồn cầu...)
thì tuyệt đối không được chuyển sang sản phẩm khác.

- Nếu lịch sử đang nói về bồn tắm thì chỉ trả lời về bồn tắm.

- Nếu lịch sử đang nói về quạt thì chỉ trả lời về quạt.

- Luôn xác định sản phẩm chính trong lịch sử hội thoại trước khi trả lời.
- Đọc toàn bộ lịch sử hội thoại trước khi trả lời.

- Không được quay lại hỏi thông tin đã có.
- Nếu khách đã cho diện tích phòng thì dùng luôn diện tích đó.
- Nếu khách đã nói quạt trần thì không hỏi lại quạt trần hay quạt đèn.
- Nếu khách đã nói công suất 65W thì tư vấn dựa trên 65W.
- Nếu khách nói "gửi qua đây cũng được", phải tư vấn tiếp trên Messenger, không xin số lại ngay.
- Nếu khách từ chối cho số/Zalo thì tối thiểu 3 lượt trao đổi sau mới xin lại.
- Không bịa giá chính xác nếu chưa có bảng giá.
- Có thể nói "giá tùy mẫu, phiên bản và kích thước".
- Tối đa 4 câu.
- Tối đa 80 từ.
- Nếu khách cho số điện thoại và Zalo thì không nhắn gì nữa


KỊCH BẢN:
- Khách hỏi giá quạt: nói có nhiều mức theo mẫu/công suất/phiên bản, tư vấn theo diện tích phòng, không xin số quá sớm.
- Khách hỏi quạt và nói phòng 28-30m2: tư vấn dòng khoảng 65W phù hợp.
- Khách nói phòng trên 30m2: tư vấn dòng công suất khoảng 70-90W hoặc mẫu gió mạnh hơn.
- Khách nói "gửi qua đây": trả lời "Dạ được anh/chị" rồi tư vấn tiếp ngay trên Messenger.
- Khách hỏi combo, nhà vệ sinh, nhà tắm, nhà bếp: hỏi phong cách, màu sắc, diện tích, ngân sách; sau đó mời showroom hoặc xin số để tư vấn trực tiếp.
- Khách chê xa: nói có hỗ trợ chi phí đến showroom và hỗ trợ vận chuyển theo chính sách.
- Khách chê đắt: nói có dòng cơ bản, trung cấp, cao cấp; hỏi ngân sách để lọc mẫu.
- Khách để lại số: không nhắn gì nữa

NHIỆM VỤ KHI TRẢ LỜI:
1. Đọc lịch sử hội thoại.
2. Xác định khách đang ở bước nào.
3. Trả lời đúng câu hỏi mới nhất.
4. Không quay lại bước cũ.
5. Nếu đã đủ thông tin thì bắt đầu gợi ý mẫu phù hợp.

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
        headers: {
            'Content-Type': 'application/json'
        },
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


async function sendComboCarousel(senderId) {
    const url = `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            recipient: { id: senderId },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "generic",
                        elements: [
                            {
                                title: "Combo phòng tắm cơ bản",
                                subtitle: "Tầm giá 4-6 triệu, phù hợp phòng tắm phổ thông",
                                image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/721841502_3407023772807451_2219495493695105387_n.jpg?stp=dst-webp_fr_q75&_nc_cat=104&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeFmFpWydFScpHjZfZGIegsMnheWmvwORraeF5aa_A5Gtshvo5X27hDJxdHeib2fiKmaVuK0QZQfMqNZl0IwaXn2&_nc_ohc=1_7eDbD6dxgQ7kNvwEKcNjN&_nc_oc=AdqWd_2C8PLDr7llHjd9sGmu9MfMK4qRr9DjS4kS_mUXqSqO3nhkLgXMt6-CYgUr-qE&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=kgSpCXlGMGObHmpM1uqlrQ&_nc_ss=7b2a8&oh=00_Af_yyrtvN6FYDEdWkds0WvrlBjF-MVk9K_EDfDjDCLH7MQ&oe=6A3F173F",
                                buttons: [
                                    {
                                        type: "phone_number",
                                        title: "Gọi tư vấn",
                                        payload: "0973693677"
                                    }
                                ]
                            },
                            {
                                title: "Combo phòng tắm đẹp",
                                subtitle: "Tầm giá 6-9 triệu, mẫu đẹp hơn, phối đồng bộ",
                                image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/724414534_3407023669474128_6654698488176819038_n.jpg?stp=dst-webp_fr_q75&_nc_cat=101&ccb=1-7&_nc_sid=c8eb1d&_nc_eui2=AeHACvlu0KvhLkjXOnnf6bOw9_sCnHDN9e_3-wKccM317-sN6_nRJrk0WbCMlpYG3AEXlLniBnW1DHIgvHDYTaA9&_nc_ohc=6WemwsdtinoQ7kNvwHVRB0a&_nc_oc=AdouwRUdoydBWrxsA-QQphXYGoL9DvO5Dmd282j-5hvGZfg931KjXi_KohvZa7l98xo&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=u-xhVRGH8O-Wqel_CNFKtw&_nc_ss=7b2a8&oh=00_Af_IKdEht3IyCtadRcq8idmCtJvhSh3JyPCFWa7WpOHD0A&oe=6A3F0FE9",
                                buttons: [
                                    {
                                        type: "phone_number",
                                        title: "Gọi tư vấn",
                                        payload: "0973693677"
                                    }
                                ]
                            },
                            {
                                title: "Combo phòng tắm cao cấp",
                                subtitle: "Từ 10 triệu trở lên, phù hợp nhà mới, biệt thự, khách sạn",
                                image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/728503197_3412240415619120_7947162624555401843_n.jpg?stp=dst-jpg_s168x128_tt6&_nc_cat=111&ccb=1-7&_nc_sid=d73f9c&_nc_eui2=AeF3mk0nPsH2Q9Tj_wooFLnspveGQ3uv0Iqm94ZDe6_QihRdvyEEDe7E6_f1A-xPZA1mLA6EZ-40_6TLeqDdD4NH&_nc_ohc=Yg1pDqiM0jwQ7kNvwGkgVuD&_nc_oc=Adprj7JBg-qAMY54CeYbt5CqkBc7jGGTz_0PEt2leWO0N-q-cyWk7PvA_rvArjTHTEQ&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=wVvG2jY_v91j5WXpHxrLyQ&_nc_ss=7b2a8&oh=00_Af-JfZhRivnIp5IXW8ZJT9eb5hXk0idM4mMk7r73vTnhPA&oe=6A3F2726",
                                buttons: [
                                    {
                                        type: "phone_number",
                                        title: "Gọi tư vấn",
                                        payload: "0973693677"
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        })
    });

    const result = await response.text();
    console.log("Combo carousel status:", response.status);
    console.log("Combo carousel result:", result);
}

async function sendFanCarousel(senderId) {
    const url = `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            recipient: { id: senderId },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "generic",
                        elements: [
                            {
                                title: "Quạt trần 5 cánh 55W",
                                subtitle: "Phù hợp phòng vừa, mẫu hiện đại, dễ phối nội thất",
                                image_url: "https://scontent.fhan5-2.fna.fbcdn.net/v/t45.1600-4/727719223_3412214488955046_3127207876950040699_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeGIbhNqPizCG827jRKi2ujsHQ5r-eC51B0dDmv54LnUHXQPXRcQPF7TG8HJicZfMBYw702DbO6KpFWzJH9aJm5T&_nc_ohc=V-ExMLpYn9EQ7kNvwGsOcGj&_nc_oc=Adr5zBbqRVUNFvx2QhS0oYraja93d0EFWSWxPusfqiE-r3ppgR8l4wSWdCKpgCnaf24&_nc_zt=1&_nc_ht=scontent.fhan5-2.fna&_nc_gid=bcw2J8GkfUEXJriVz1oLOQ&_nc_ss=7b2a8&oh=00_Af_YhRRmZgntjGTgS36kmpcsqaU1W_kyjRzgDCs2mVLdwA&oe=6A3F095A",
                                buttons: [
                                    {
                                        type: "phone_number",
                                        title: "Gọi tư vấn",
                                        payload: "0973693677"
                                    }
                                ]
                            },
                            {
                                title: "Quạt trần 5 cánh 90W",
                                subtitle: "Gió mạnh hơn, phù hợp phòng lớn hoặc cần thoáng mát",
                                image_url: "https://scontent.fhan5-8.fna.fbcdn.net/v/t45.1600-4/729088829_3412214475621714_8370697354332284349_n.jpg?_nc_cat=108&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeEXTBgj2blEZtj5XpRbwq_fJE2SQubOxP8kTZJC5s7E_4rIdsmmzF-6HyCiTRpgvp306okGBoT89V91lrhOh31h&_nc_ohc=Sv01MBSqGuYQ7kNvwERCf_a&_nc_oc=AdoCjduM22tUgLaO3keafuLJsnERx0hZWZPntd6VrkH0quDRDZgzHL2iS7NIZSvT9uc&_nc_zt=1&_nc_ht=scontent.fhan5-8.fna&_nc_gid=aJDU5max7NArlA__yCpytQ&_nc_ss=7b2a8&oh=00_Af_l1bxVslTjPhOMBSODpzbWSJOz90pDwRY5KayP9dc3Mw&oe=6A3F1053",
                                buttons: [
                                    {
                                        type: "phone_number",
                                        title: "Gọi tư vấn",
                                        payload: "0973693677"
                                    }
                                ]
                            },
                            {
                                title: "Quạt 8 cánh vàng gương",
                                subtitle: "Mẫu sang, hợp phòng khách, biệt thự, nhà hàng",
                                image_url: "https://scontent.fhan5-10.fna.fbcdn.net/v/t45.1600-4/728760035_3412214442288384_2821812757948103391_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeE1gLmEnYhcYcAdRm8Y4Efkto6qjVItQGq2jqqNUi1AapSW-7fcjspTeNE7RfslV2U2aqUW60_vaRtgX98O0UA4&_nc_ohc=tYU3byEPwI4Q7kNvwFf8Y9R&_nc_oc=AdqDOn6-rpBe36YXADWcDu7GdCx10JwawIw2QXny5P8lsKet-WABjseVL42k6xqPB4k&_nc_zt=1&_nc_ht=scontent.fhan5-10.fna&_nc_gid=Sq569PbIRY0sEDsucJnQeA&_nc_ss=7b2a8&oh=00_Af-gu2ESXEnmmi83L6x99RSXRZ2vAwc_iVahh3CxEpzuSw&oe=6A3EF448",
                                buttons: [
                                    {
                                        type: "phone_number",
                                        title: "Gọi tư vấn",
                                        payload: "0973693677"
                                    }
                                ]
                            },
                            {
                                title: "Quạt 10 cánh cao cấp",
                                subtitle: "Sải lớn, hợp phòng khách rộng, không gian sang trọng",
                                image_url: "https://scontent.fhan5-9.fna.fbcdn.net/v/t45.1600-4/728597413_3412225568953938_5048258706912707012_n.jpg?_nc_cat=110&ccb=1-7&_nc_sid=d5bd00&_nc_eui2=AeF9_KEAt19bMbLGn9ImPdBErXek8XEmc1Std6TxcSZzVJcqNZD2S29UtKFH2hKEKAanUmzGmvpFHDAbbuFUebxx&_nc_ohc=9hQEkg60bncQ7kNvwFMP4Qb&_nc_oc=AdoO5dx259kvQ_3xJWioFcjyyCEHM9XD2jwHQ5Jn2d78H8ZBjY6JwcRy6QbFFIm6P8E&_nc_zt=1&_nc_ht=scontent.fhan5-9.fna&_nc_gid=H81qwU0PpFnPWUSKJeZqCw&_nc_ss=7b2a8&oh=00_Af8j0NRqieKJFAi1UyLA5JHDTbH_cX8-3a8q1Oi9S-uAiw&oe=6A3F1338",
                                buttons: [
                                    {
                                        type: "phone_number",
                                        title: "Gọi tư vấn",
                                        payload: "0973693677"
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        })
    });

    const result = await response.text();
    console.log("Fan carousel status:", response.status);
    console.log("Fan carousel result:", result);
}

async function sendProductCarouselIfNeeded(senderId, customerMessage, history) {
    const text = `${customerMessage}\n${history}`.toLowerCase();

    const wantsImage =
        text.includes("gửi ảnh") ||
        text.includes("gui anh") ||
        text.includes("xem mẫu") ||
        text.includes("xem mau") ||
        text.includes("gửi mẫu") ||
        text.includes("gui mau") ||
        text.includes("cho xem") ||
        text.includes("ảnh") ||
        text.includes("anh");

    const isFan =
        text.includes("quạt") ||
        text.includes("quat") ||
        text.includes("quạt trần") ||
        text.includes("quạt đèn");

    const isCombo =
        text.includes("combo") ||
        text.includes("phòng tắm") ||
        text.includes("phong tam") ||
        text.includes("nhà tắm") ||
        text.includes("nha tam") ||
        text.includes("thiết bị vệ sinh") ||
        text.includes("thiet bi ve sinh") ||
        text.includes("bồn cầu") ||
        text.includes("bon cau") ||
        text.includes("lavabo") ||
        text.includes("sen tắm");

    if (!wantsImage) return;

    if (isFan) {
        await sendFanCarousel(senderId);
        return;
    }

    if (isCombo) {
        await sendComboCarousel(senderId);
    }
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

    console.log("Customer ID:", senderId);
    console.log("Customer Message:", customerMessage);

    if (!conversations[senderId]) {
        conversations[senderId] = [];
    }

    conversations[senderId].push(`Khách: ${customerMessage}`);

    // Lưu ngay tin khách để restart nhẹ vẫn còn lịch sử
    conversations[senderId] = conversations[senderId].slice(-60);
    saveConversations(conversations);

    // Gửi nhiều lịch sử hơn cho GPT để tránh hỏi lặp
    const history = conversations[senderId].slice(-30).join("\n");

    console.log("Calling OpenAI...");

    const aiReply = await getAIReply(history);

    conversations[senderId].push(`Bot: ${aiReply}`);

    // Giữ tối đa 60 dòng gần nhất cho mỗi khách
    conversations[senderId] = conversations[senderId].slice(-60);

    // Lưu cả câu trả lời của bot
    saveConversations(conversations);

    console.log("AI Reply:", aiReply);

    await sendMessage(senderId, aiReply);

    // Nếu khách xin xem ảnh/mẫu, tự gửi carousel phù hợp
    await sendProductCarouselIfNeeded(senderId, customerMessage, history);
}

app.post('/webhook', async (req, res) => {
    console.log("========== WEBHOOK HIT ==========");
    console.log(JSON.stringify(req.body, null, 2));

    const body = req.body;

    if (body.object !== 'page') {
        return res.sendStatus(404);
    }

    // Trả lời Meta ngay để tránh timeout và gửi lặp
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
});
