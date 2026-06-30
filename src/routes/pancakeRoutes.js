const express = require("express");

const {
    PANCAKE_PAGE_ID,
    pancakeFetchConversations,
    pancakeBuildCustomerRow,
    pancakeConversationDateString,
    pancakeReviewFilterRows,
    pancakeReviewTypeLabel,
    pancakeVietnamDateString
} = require("../services/pancakeService");

function createPancakeRoutes() {
    const router = express.Router();

    router.get('/pancake-report', async (req, res) => {
        try {
            const limit = req.query.limit || 300;
            const conversations = await pancakeFetchConversations(limit);
            const report = conversations.map(pancakeBuildCustomerRow);

            const summary = {
                total: report.length,
                has_phone: report.filter(x => x.has_phone).length,
                no_phone: report.filter(x => !x.has_phone).length,
                hot_no_phone: report.filter(x => x.hot_lead && !x.has_phone).length,
                called: report.filter(x => x.tags.includes("Đã Gọi")).length,
                zalo: report.filter(x => x.tags.includes("Zalo")).length,
                not_buy: report.filter(x => x.tags.includes("k mua")).length,
                by_product: {
                    quat: report.filter(x => x.product === "Quạt").length,
                    thiet_bi_ve_sinh: report.filter(x => x.product === "Thiết bị vệ sinh").length,
                    combo_phong_tam: report.filter(x => x.product === "Combo phòng tắm").length,
                    bep: report.filter(x => x.product === "Bếp").length,
                    bon_tam: report.filter(x => x.product === "Bồn tắm").length,
                    khac: report.filter(x => x.product === "Khác").length
                }
            };

            res.json({
                success: true,
                page_id: PANCAKE_PAGE_ID,
                summary,
                hot_no_phone_customers: report.filter(x => x.hot_lead && !x.has_phone),
                customers_with_phone: report.filter(x => x.has_phone),
                customers_no_phone: report.filter(x => !x.has_phone),
                all_customers: report
            });
        } catch (error) {
            console.error("Pancake report error:", error);
            res.status(500).json({
                success: false,
                message: "Lỗi khi thống kê Pancake",
                error: error.message
            });
        }
    });

    router.get('/pancake-report-text', async (req, res) => {
        try {
            const limit = req.query.limit || 300;
            const conversations = await pancakeFetchConversations(limit);
            const report = conversations.map(pancakeBuildCustomerRow);

            const total = report.length;
            const hasPhone = report.filter(x => x.has_phone).length;
            const noPhone = report.filter(x => !x.has_phone).length;
            const hotNoPhone = report.filter(x => x.hot_lead && !x.has_phone);
            const called = report.filter(x => x.tags.includes("Đã Gọi")).length;
            const zalo = report.filter(x => x.tags.includes("Zalo")).length;
            const notBuy = report.filter(x => x.tags.includes("k mua")).length;

            const productLines = [
                `Quạt: ${report.filter(x => x.product === "Quạt").length}`,
                `Thiết bị vệ sinh: ${report.filter(x => x.product === "Thiết bị vệ sinh").length}`,
                `Combo phòng tắm: ${report.filter(x => x.product === "Combo phòng tắm").length}`,
                `Bếp: ${report.filter(x => x.product === "Bếp").length}`,
                `Bồn tắm: ${report.filter(x => x.product === "Bồn tắm").length}`,
                `Khác: ${report.filter(x => x.product === "Khác").length}`
            ];

            const hotLines = hotNoPhone.slice(0, 30).map((x, index) => {
                return `${index + 1}. ${x.name} | ${x.product} | ${x.updated_at}\n   Nội dung: ${x.snippet}\n   ID: ${x.conversation_id}`;
            });

            const phoneLines = report
                .filter(x => x.has_phone)
                .slice(0, 50)
                .map((x, index) => {
                    return `${index + 1}. ${x.name} | ${x.phones.join(", ") || "Có số nhưng chưa đọc được số"} | ${x.product} | ${x.tags.join(", ") || "Chưa tag"}`;
                });

            res.type('text/plain').send(
`BÁO CÁO PANCAKE
Page ID: ${PANCAKE_PAGE_ID}
Số hội thoại lấy gần nhất: ${total}

TỔNG QUAN
- Có số điện thoại: ${hasPhone}
- Chưa có số điện thoại: ${noPhone}
- Khách nóng chưa có số: ${hotNoPhone.length}
- Đã gọi: ${called}
- Có tag Zalo: ${zalo}
- Không mua: ${notBuy}

PHÂN LOẠI SẢN PHẨM
${productLines.join("\n")}

KHÁCH NÓNG CHƯA CÓ SỐ
${hotLines.length ? hotLines.join("\n\n") : "Không có"}

KHÁCH ĐÃ CÓ SỐ
${phoneLines.length ? phoneLines.join("\n") : "Không có"}
`
            );
        } catch (error) {
            console.error("Pancake text report error:", error);
            res.status(500).type('text/plain').send(`Lỗi khi thống kê Pancake: ${error.message}`);
        }
    });

    router.get('/pancake-review', async (req, res) => {
        try {
            const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
            const type = String(req.query.type || "all").toLowerCase();
            const date = req.query.date ? String(req.query.date).slice(0, 10) : pancakeVietnamDateString();

            const conversations = await pancakeFetchConversations(limit);
            const report = conversations.map(pancakeBuildCustomerRow);

            const todayRows = report.filter(x => pancakeConversationDateString(x.updated_at) === date);
            const rows = pancakeReviewFilterRows(todayRows, type);

            const summary = {
                total_today: todayRows.length,
                showing: rows.length,
                has_phone: rows.filter(x => x.has_phone).length,
                no_phone: rows.filter(x => !x.has_phone).length,
                hot_no_phone: rows.filter(x => x.hot_lead && !x.has_phone).length,
                zalo: rows.filter(x => x.tags.includes("Zalo")).length,
                called: rows.filter(x => x.tags.includes("Đã Gọi")).length
            };

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');

            let text = "";
            text += `PANCAKE REVIEW BOT\n`;
            text += `Ngày: ${date}\n`;
            text += `Loại xem: ${pancakeReviewTypeLabel(type)}\n`;
            text += `Số hội thoại lấy gần nhất: ${limit}\n\n`;

            text += `TỔNG QUAN THEO BỘ LỌC\n`;
            text += `- Hội thoại hôm nay trong dữ liệu lấy về: ${summary.total_today}\n`;
            text += `- Đang hiển thị: ${summary.showing}\n`;
            text += `- Có số điện thoại: ${summary.has_phone}\n`;
            text += `- Chưa có số điện thoại: ${summary.no_phone}\n`;
            text += `- Khách nóng chưa có số: ${summary.hot_no_phone}\n`;
            text += `- Có tag Zalo: ${summary.zalo}\n`;
            text += `- Đã gọi: ${summary.called}\n\n`;

            text += `DANH SÁCH HỘI THOẠI\n`;

            if (rows.length === 0) {
                text += `Không có hội thoại phù hợp bộ lọc này.\n`;
            }

            rows.forEach((x, index) => {
                text += `\n${index + 1}. ${x.name} | ${x.product} | ${x.updated_at}\n`;
                text += `   ID: ${x.conversation_id}\n`;
                text += `   SĐT: ${x.phones.join(", ") || "Chưa có"}\n`;
                text += `   Tags: ${x.tags.join(", ") || "Không có"}\n`;
                text += `   Khách nóng: ${x.hot_lead ? "Có" : "Không"}\n`;
                text += `   Nội dung gần nhất: ${x.snippet || ""}\n`;
            });

            text += `\n\nGỢI Ý LINK NHANH\n`;
            text += `/pancake-review?limit=${limit}&type=all\n`;
            text += `/pancake-review?limit=${limit}&type=hot\n`;
            text += `/pancake-review?limit=${limit}&type=no-phone\n`;
            text += `/pancake-review?limit=${limit}&type=phone\n`;
            text += `/pancake-review?limit=${limit}&type=no-called\n`;

            res.send(text);
        } catch (error) {
            console.error("Pancake review error:", error);
            res.status(500).type('text/plain').send("Lỗi khi tạo Pancake review: " + error.message);
        }
    });

    return router;
}

module.exports = createPancakeRoutes;
