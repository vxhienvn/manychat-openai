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
        customerStates[senderId] = {};
    }

    const state = customerStates[senderId];

    if (!("productType" in state)) state.productType = null;
    if (!("currentTopic" in state)) state.currentTopic = state.productType || null;
    if (!("currentSubTopic" in state)) state.currentSubTopic = null;
    if (!Array.isArray(state.previousTopics)) state.previousTopics = [];
    if (!Array.isArray(state.carouselSent)) state.carouselSent = [];
    if (!("lastCustomerTime" in state)) state.lastCustomerTime = null;
    if (!("hasContact" in state)) state.hasContact = false;
    if (!("followUp8hSent" in state)) state.followUp8hSent = false;

    if (typeof state.followUpOnceSent === "undefined") {
        state.followUpOnceSent = Boolean(state.followUp8hSent);
    }

    if (!state.stage) state.stage = "DISCOVERY";
    if (typeof state.lastIntent === "undefined") state.lastIntent = null;
    if (typeof state.lastSampleTime === "undefined") state.lastSampleTime = null;
    if (typeof state.sampleSentCount === "undefined") state.sampleSentCount = 0;
    if (typeof state.lastPhoneAskTime === "undefined") state.lastPhoneAskTime = null;
    if (typeof state.askedPhone === "undefined") state.askedPhone = false;
    if (typeof state.phoneRejected === "undefined") state.phoneRejected = false;
    if (typeof state.preferMessenger === "undefined") state.preferMessenger = false;
    if (typeof state.lastFollowUpTime === "undefined") state.lastFollowUpTime = null;
    if (typeof state.lastCarouselTime === "undefined") state.lastCarouselTime = null;

    return state;
}

module.exports = {
    STATE_FILE,
    loadCustomerStates,
    saveCustomerStates,
    ensureCustomerState
};
