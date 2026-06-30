const express = require("express");

const config = require("../config");
const {
    HISTORY_FILE,
    loadConversations
} = require("../storage/historyStore");

const {
    PANCAKE_PAGE_ID,
    PANCAKE_PAGE_ACCESS_TOKEN
} = require("../services/pancakeService");

function createDebugRoutes() {
    const router = express.Router();

    router.get('/bot-history-keys', (req, res) => {
        const conversations = loadConversations();
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(Object.keys(conversations).slice(0, 200).join("\n") || "Không có key nào");
    });

    router.get('/history-debug', (req, res) => {
        const conversations = loadConversations();

        res.json({
            file: HISTORY_FILE,
            keys: Object.keys(conversations).length,
            sample: Object.keys(conversations).slice(0, 10)
        });
    });

    router.get('/pancake-debug', async (req, res) => {
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

    router.get('/bot-history', (req, res) => {
        const id = req.query.id;
        const conversations = loadConversations();

        if (!id) return res.status(400).send("Thiếu id khách/PSID");

        const history = conversations[id] || [];

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(history.join("\n\n") || "Không có lịch sử trong server");
    });

    router.get('/pancake-conversation', async (req, res) => {
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

    return router;
}

module.exports = createDebugRoutes;
