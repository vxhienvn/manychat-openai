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
- Đọc toàn bộ lịch sử hội thoại trước khi trả lời.
- Khách nhắn tin hỏi giá, xin giá, xin mẫu, xin thông tin (tt) thì xin số tư vấn trực tiếp luôn, nếu khách không cho số thì tư vấn tiếp trên Messenger, tư vấn 2-3 câu thì xin số tiếp.
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

KỊCH BẢN:
- Khách hỏi giá quạt: nói có nhiều mức theo mẫu/công suất/phiên bản, tư vấn theo diện tích phòng, không xin số quá sớm.
- Khách hỏi quạt và nói phòng 28-30m2: tư vấn dòng khoảng 65W phù hợp.
- Khách nói phòng trên 30m2: tư vấn dòng công suất khoảng 70-90W hoặc mẫu gió mạnh hơn.
- Khách nói "gửi qua đây": trả lời "Dạ được anh/chị" rồi tư vấn tiếp ngay trên Messenger.
- Khách hỏi combo, nhà vệ sinh, nhà tắm, nhà bếp: hỏi phong cách, màu sắc, diện tích, ngân sách; sau đó mời showroom hoặc xin số để tư vấn trực tiếp.
- Khách chê xa: nói có hỗ trợ chi phí đến showroom và hỗ trợ vận chuyển theo chính sách.
- Khách chê đắt: nói có dòng cơ bản, trung cấp, cao cấp; hỏi ngân sách để lọc mẫu.
- Khách để lại số: cảm ơn và xác nhận nhân viên sẽ liên hệ.

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
