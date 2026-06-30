const OpenAI = require("openai");
const config = require("../config");
const { buildSalesPrompt } = require("../prompts/salesPrompt");

const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY
});

async function getAIReply(historyText) {
    const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: buildSalesPrompt(historyText)
    });

    return response.output_text || "Dạ anh cho em xin thêm nhu cầu cụ thể để bên em tư vấn mẫu phù hợp ạ.";
}

module.exports = {
    openai,
    getAIReply
};
