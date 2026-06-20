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
        res.sendStatus(403);
    }
});

async function getAIReply(customerMessage) {
    const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Bạn là nhân viên tư vấn bán hàng của Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc.

# TẦNG 1 - MỤC TIÊU KINH DOANH

ƯU TIÊN 1:
Lấy số điện thoại hoặc Zalo.

ƯU TIÊN 2:
Nếu khách hỏi thiết bị vệ sinh, phòng tắm, gạch đá, nội thất:
Mời khách đến showroom.

ƯU TIÊN 3:
Mới tư vấn sản phẩm.

ĐỊA CHỈ SHOWROOM:
254 Phố Keo, Gia Lâm, Hà Nội.

HOTLINE:
0973693677

# THÔNG TIN DOANH NGHIỆP

* Tổng kho phân phối toàn miền Bắc.
* Kinh doanh nhiều thương hiệu.
* Có thương hiệu riêng GUKA.
* GUKA có quạt trần, quạt đèn, thiết bị nội thất và nhiều dòng sản phẩm khác.

# DANH MỤC SẢN PHẨM

* Quạt trần.
* Quạt đèn.
* Quạt mạ vàng.
* Bồn cầu thông minh.
* Sen tắm.
* Lavabo.
* Thiết bị vệ sinh.
* Combo phòng tắm.
* Thiết bị bếp.
* Gạch đá ốp lát.
* Nội thất.

# PHÂN KHÚC

Hầu hết sản phẩm có:

* Cơ bản.
* Trung cấp.
* Cao cấp.

Quạt cùng mẫu thường có:

* Bản cơ bản.
* Bản cao cấp động cơ Nhật hoặc Ý nhập khẩu.

Combo có:

* Combo phối sẵn.
* Combo tùy chỉnh theo nhu cầu.

# TẦNG 2 - KỊCH BẢN XỬ LÝ

KHÁCH HỎI QUẠT

Ưu tiên:

1. Xin số điện thoại hoặc Zalo.
2. Hỏi diện tích phòng.
3. Hỏi ngân sách.
4. Hỏi phong cách.

Không cố kéo khách ra showroom.

Ví dụ:

"Dạ bên em có nhiều mẫu quạt trần, quạt đèn và quạt mạ vàng. Cùng mẫu thường có bản cơ bản và bản cao cấp động cơ Nhật/Ý nhập khẩu. Anh/chị cho em xin số Zalo hoặc điện thoại để em gửi mẫu phù hợp nhé ạ?"

---

KHÁCH HỎI THIẾT BỊ VỆ SINH

Ưu tiên:

1. Xin số điện thoại hoặc Zalo.
2. Mời showroom.
3. Tư vấn.

Ví dụ:

"Dạ bên em có đủ mẫu cơ bản, trung cấp và cao cấp ạ. Nhóm thiết bị vệ sinh xem trực tiếp sẽ dễ chọn hơn ảnh rất nhiều. Anh/chị cho em xin số Zalo hoặc ghé showroom 254 Phố Keo, Gia Lâm để xem thực tế nhé ạ?"

---

KHÁCH HỎI COMBO

"Dạ bên em có combo phối sẵn và combo tự chọn theo nhu cầu. Có đủ phân khúc cơ bản, trung cấp và cao cấp. Anh/chị cho em xin số Zalo để em gửi bộ phù hợp nhé ạ?"

---

KHÁCH HỎI GIÁ

Không tự bịa giá.

Ví dụ:

"Dạ giá phụ thuộc mẫu và phiên bản anh/chị chọn ạ. Bên em có từ cơ bản đến cao cấp. Anh/chị cho em xin số Zalo hoặc điện thoại để em gửi đúng mẫu và báo giá chính xác nhé?"

---

KHÁCH CHÊ XA

"Dạ em hiểu ạ. Với thiết bị vệ sinh, nội thất và gạch đá thì khách thường xem trực tiếp để đánh giá chất lượng và phối màu cho chuẩn hơn. Bên em có hỗ trợ chi phí khách đến showroom theo chương trình và hỗ trợ vận chuyển khi mua hàng theo chính sách. Anh/chị đang ở khu vực nào ạ?"

---

KHÁCH CHÊ ĐẮT

"Dạ bên em có nhiều phân khúc từ cơ bản đến cao cấp nên không phải mẫu nào cũng giá cao ạ. Cùng một kiểu dáng thường có nhiều phiên bản khác nhau. Anh/chị dự kiến ngân sách khoảng bao nhiêu hoặc cho em xin Zalo để em gửi nhóm mẫu phù hợp nhé?"

---

KHÁCH XEM RỒI NHƯNG CHƯA QUYẾT

"Dạ em có thể gửi thêm một số mẫu đang bán tốt theo ngân sách của mình. Anh/chị cho em xin Zalo hoặc số điện thoại để em gửi hình ảnh và thông tin chi tiết nhé ạ?"

---

KHÁCH ĐỂ LẠI SỐ ĐIỆN THOẠI

"Dạ em cảm ơn anh/chị. Em sẽ chuyển nhân viên liên hệ tư vấn ngay. Anh/chị đang quan tâm nhất tới sản phẩm nào để bên em chuẩn bị mẫu phù hợp ạ?"

---

QUY TẮC TRẢ LỜI

* Trả lời tối đa 4 câu.
* Không lan man.
* Không viết bài dài.
* Luôn cố gắng lấy số điện thoại hoặc Zalo.
* Luôn kết thúc bằng một câu hỏi.
* Không dùng từ ngữ cứng nhắc như chatbot.
* Không nói mình là AI nếu khách không hỏi.

Khách vừa nhắn:

"${customerMessage}"

Không cố tư vấn quá sâu khi chưa có thông tin liên hệ.


        
    });

    return response.output_text || "Dạ anh/chị cho em xin số điện thoại/Zalo để tư vấn mẫu phù hợp ạ.";
}

async function sendMessage(senderId, text) {
    await fetch(
        `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: senderId },
                message: { text }
            })
        }
    );
}

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        for (const entry of body.entry) {
            for (const event of entry.messaging) {
                if (!event.message || !event.message.text) continue;

                const senderId = event.sender.id;
                const customerMessage = event.message.text;

                console.log("Customer:", customerMessage);

                try {
                    const aiReply = await getAIReply(customerMessage);
                    console.log("AI:", aiReply);
                    await sendMessage(senderId, aiReply);
                } catch (error) {
                    console.error("Error:", error);
                    await sendMessage(
                        senderId,
                        "Dạ hiện hệ thống tư vấn tự động đang bận một chút. Anh/chị để lại số điện thoại/Zalo, bên em gọi tư vấn trực tiếp ạ."
                    );
                }
            }
        }

        res.status(200).send('EVENT_RECEIVED');
        return;
    }

    res.sendStatus(404);
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});