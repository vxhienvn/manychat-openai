const config = {
    VERIFY_TOKEN: process.env.VERIFY_TOKEN,
    PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,

    PANCAKE_PAGE_ID: process.env.PANCAKE_PAGE_ID,
    PANCAKE_PAGE_ACCESS_TOKEN: process.env.PANCAKE_PAGE_ACCESS_TOKEN,

    PORT: process.env.PORT || 10000
};

module.exports = config;
