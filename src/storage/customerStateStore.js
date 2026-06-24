const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "../../customer_states.json");

function loadCustomerStates() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
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

function ensureCustomerState(customerStates, senderId) {
    if (!customerStates[senderId]) {
        customerStates[senderId] = {
            productType: null,
            lastCustomerTime: null,
            hasContact: false,

            // Giữ tương thích dữ liệu cũ
            followUp8hSent: false,

            // Cờ an toàn: tự động chăm sóc 1 lần duy nhất
            followUpOnceSent: false,

            // Sales stage mới
            stage: "DISCOVERY",
            lastIntent: null,
            lastSampleTime: null,
            sampleSentCount: 0,
            lastPhoneAskTime: null,

            lastFollowUpTime: null,
            lastCarouselTime: null
        };
    }

    if (typeof customerStates[senderId].followUpOnceSent === "undefined") {
        customerStates[senderId].followUpOnceSent = Boolean(customerStates[senderId].followUp8hSent);
    }

    if (!customerStates[senderId].stage) customerStates[senderId].stage = "DISCOVERY";
    if (typeof customerStates[senderId].sampleSentCount === "undefined") customerStates[senderId].sampleSentCount = 0;
    if (typeof customerStates[senderId].lastSampleTime === "undefined") customerStates[senderId].lastSampleTime = null;
    if (typeof customerStates[senderId].lastPhoneAskTime === "undefined") customerStates[senderId].lastPhoneAskTime = null;
    if (typeof customerStates[senderId].lastIntent === "undefined") customerStates[senderId].lastIntent = null;

    return customerStates[senderId];
}

module.exports = {
    STATE_FILE,
    loadCustomerStates,
    saveCustomerStates,
    ensureCustomerState
};
