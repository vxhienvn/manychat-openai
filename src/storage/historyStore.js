const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "../../conversations.json");

function loadConversations() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
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

module.exports = {
    HISTORY_FILE,
    loadConversations,
    saveConversations
};
