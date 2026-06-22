const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// Bộ nhớ hội thoại tạm thời
// Lưu trong RAM, Render restart thì mất
const conversations = {};

app.get('/', (req, res) => {
    res.send('Server OK');
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Webhook verified');
        res.status(200).send(challenge);
    } else {
        console.log('Webhook verification failed');
        res.sendStatus(403);
    }
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
- Phải dựa vào lịch sử hội thoại, không hỏi lại thông tin khách đã nói.

THÔNG TIN DOANH NGHIỆP:
- Tổng kho phân phối toàn miền Bắc.
- Kinh doanh nhiều thương hiệu khác nhau.
- Có thương hiệu riêng GUKA.
- GUKA có quạt trần, quạt đèn, thiết bị nội thất và nhiều dòng sản phẩm khác.
- Showroom: 254 Phố Keo, Gia Lâm, Hà Nội.
- Hotline/Zalo: 0973693677.

SẢN PHẨM:
- Quạt trần, quạt đèn, quạt mạ vàng.
- Bồn cầu thông minh, sen tắm, lavabo, thiết bị vệ sinh.
- Combo phòng tắm, thiết bị bếp, gạch đá ốp lát, nội thất.

PHÂN KHÚC:
- Cơ bản, trung cấp, cao cấp.
- Quạt cùng mẫu thường có bản cơ bản và bản cao cấp động cơ Nhật/Ý nhập khẩu.
- Combo có loại phối sẵn và loại tự chọn theo nhu cầu.

MỤC TIÊU ƯU TIÊN:
1. Xin số điện thoại hoặc Zalo.
2. Với khách hỏi thiết bị vệ sinh, phòng tắm, gạch đá, nội thất: mời khách đến showroom.
3. Sau đó mới tư vấn sâu.

KỊCH BẢN:
- Khách hỏi quạt: hỏi diện tích, ngân sách, phong cách nếu chưa có. Nếu khách đã nói diện tích/phong cách rồi thì không hỏi lại.
- Khách hỏi thiết bị vệ sinh/phòng tắm/gạch đá/nội thất: xin số Zalo và mời qua showroom 254 Phố Keo, Gia Lâm.
- Khách hỏi giá: không bịa giá, nói giá phụ thuộc mẫu/phiên bản/số lượng, xin Zalo để gửi mẫu và báo giá.
- Khách chê xa: nói có hỗ trợ chi phí đến showroom theo chương trình và hỗ trợ vận chuyển khi mua hàng theo chính sách.
- Khách chê đắt: nói có phân khúc cơ bản, trung cấp, cao cấp; hỏi ngân sách và xin Zalo.
- Khách để lại số: cảm ơn, xác nhận nhân viên sẽ liên hệ, hỏi thêm sản phẩm quan tâm.

QUY TẮC:
- Tối đa 4 câu.
- Tối đa 80 từ.
- Không hỏi lại thông tin khách đã cung cấp.
- Luôn cố gắng lấy số điện thoại hoặc Zalo.
- Luôn kết thúc bằng câu hỏi.
- Không tư vấn quá sâu khi chưa có thông tin liên hệ.

LỊCH SỬ HỘI THOẠI:
${history}
        `
    });

    return response.output_text || "Dạ anh/chị cho em xin số điện thoại/Zalo để bên em tư vấn mẫu phù hợp ạ.";
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

app.post('/webhook', async (req, res) => {
    console.log("========== WEBHOOK HIT ==========");
    console.log(JSON.stringify(req.body, null, 2));

    const body = req.body;

    if (body.object !== 'page') {
        res.sendStatus(404);
        return;
    }

    for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
            if (!event.message || !event.message.text) {
                continue;
            }

            if (event.message.is_echo) {
                console.log("Ignore echo message");
                continue;
            }

            const senderId = event.sender.id;
            const customerMessage = event.message.text;

            console.log("Customer ID:", senderId);
            console.log("Customer Message:", customerMessage);

            try {
                if (!conversations[senderId]) {
                    conversations[senderId] = [];
                }

                conversations[senderId].push(`Khách: ${customerMessage}`);

                const history = conversations[senderId].slice(-10).join("\n");

                console.log("Calling OpenAI...");

                const aiReply = await getAIReply(history);

                conversations[senderId].push(`Bot: ${aiReply}`);

                // Chỉ giữ tối đa 20 dòng gần nhất để nhẹ server
                conversations[senderId] = conversations[senderId].slice(-20);

                console.log("AI Reply:", aiReply);

                await sendMessage(senderId, aiReply);
            } catch (error) {
                console.error("Error:", error);

                try {
                    await sendMessage(
                        senderId,
                        "Dạ hiện hệ thống tư vấn tự động đang bận một chút. Anh/chị để lại số điện thoại/Zalo, bên em gọi tư vấn trực tiếp ạ."
                    );
                } catch (sendError) {
                    console.error("Fallback send error:", sendError);
                }
            }
        }
    }

    res.status(200).send('EVENT_RECEIVED');
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});