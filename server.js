const express = require('express');

const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

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

app.post('/webhook', async (req, res) => {

    const body = req.body;

    if (body.object === 'page') {

        for (const entry of body.entry) {

            const webhookEvent = entry.messaging[0];

            if (!webhookEvent.message) continue;

            const senderId = webhookEvent.sender.id;

            await fetch(
                `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        recipient: {
                            id: senderId
                        },
                        message: {
                            text: 'Chào anh/chị. Em là trợ lý AI của Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc. Anh/chị đang quan tâm quạt hay thiết bị vệ sinh ạ?'
                        }
                    })
                }
            );

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