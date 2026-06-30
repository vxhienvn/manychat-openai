const express = require("express");

const {
    pancakeFetchConversations,
    pancakeBuildCustomerRow
} = require("../services/pancakeService");

function createDashboardRoutes() {
    const router = express.Router();


// Dashboard tổng quan, theo ngày, theo giờ, khách nóng và bộ lọc chọn nhanh trên điện thoại.
// Link dùng nhanh:
// /dashboard?limit=500
// /dashboard-today?limit=500
// /dashboard-yesterday?limit=500
// /dashboard?date=2026-06-22&limit=500
// /dashboard?hours=24&limit=500
// /dashboard-hot?limit=500

function dashboardEscapeHtml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function dashboardDateKeyVN(dateInput) {
    const d = new Date(dateInput);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

function dashboardTodayKeyVN(offsetDays = 0) {
    const now = new Date();
    const vnNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    vnNow.setDate(vnNow.getDate() + offsetDays);
    const y = vnNow.getFullYear();
    const m = String(vnNow.getMonth() + 1).padStart(2, "0");
    const d = String(vnNow.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function dashboardNormalizeProduct(product = "all") {
    const value = String(product || "all").toLowerCase();
    const map = {
        all: "all",
        quat: "Quạt",
        fan: "Quạt",
        thiet_bi_ve_sinh: "Thiết bị vệ sinh",
        tbvs: "Thiết bị vệ sinh",
        combo: "Combo phòng tắm",
        combo_phong_tam: "Combo phòng tắm",
        bep: "Bếp",
        bon_tam: "Bồn tắm",
        khac: "Khác"
    };
    return map[value] || "all";
}

function dashboardProductParamFromName(name = "all") {
    const map = {
        "Quạt": "quat",
        "Thiết bị vệ sinh": "thiet_bi_ve_sinh",
        "Combo phòng tắm": "combo",
        "Bếp": "bep",
        "Bồn tắm": "bon_tam",
        "Khác": "khac"
    };
    return map[name] || "all";
}

function dashboardFilterReport(report, req, mode = "all") {
    const dateParam = req.query.date;
    const hoursParam = req.query.hours;
    let title = "Tổng quan gần nhất";
    let filtered = report;

    if (hoursParam) {
        const hours = Math.min(Math.max(Number(hoursParam) || 24, 1), 168);
        const fromTime = Date.now() - hours * 60 * 60 * 1000;
        title = `${hours} giờ gần nhất`;
        filtered = filtered.filter(x => {
            const t = new Date(x.updated_at).getTime();
            return !Number.isNaN(t) && t >= fromTime;
        });
    } else {
        let targetDate = null;

        if (dateParam) {
            targetDate = String(dateParam).trim();
        } else if (mode === "today") {
            targetDate = dashboardTodayKeyVN(0);
        } else if (mode === "yesterday") {
            targetDate = dashboardTodayKeyVN(-1);
        }

        if (targetDate) {
            title = `Ngày ${targetDate}`;
            filtered = filtered.filter(x => dashboardDateKeyVN(x.updated_at) === targetDate);
        }
    }

    const productName = dashboardNormalizeProduct(req.query.product || "all");
    if (productName !== "all") {
        title += ` | ${productName}`;
        filtered = filtered.filter(x => x.product === productName);
    }

    if (mode === "hot") {
        title = `Khách nóng chưa có số | ${title}`;
        filtered = filtered.filter(x => x.hot_lead && !x.has_phone);
    }

    return { title, report: filtered, productName };
}

function dashboardBuildStats(report) {
    const total = report.length;
    const hasPhone = report.filter(x => x.has_phone).length;
    const noPhone = report.filter(x => !x.has_phone).length;
    const hotNoPhone = report.filter(x => x.hot_lead && !x.has_phone);
    const called = report.filter(x => x.tags.includes("Đã Gọi")).length;
    const zalo = report.filter(x => x.tags.includes("Zalo")).length;
    const notBuy = report.filter(x => x.tags.includes("k mua")).length;
    const phoneRate = total ? ((hasPhone / total) * 100).toFixed(1) : "0.0";

    const productCount = {
        quat: report.filter(x => x.product === "Quạt").length,
        thietBiVeSinh: report.filter(x => x.product === "Thiết bị vệ sinh").length,
        comboPhongTam: report.filter(x => x.product === "Combo phòng tắm").length,
        bep: report.filter(x => x.product === "Bếp").length,
        bonTam: report.filter(x => x.product === "Bồn tắm").length,
        khac: report.filter(x => x.product === "Khác").length
    };

    return { total, hasPhone, noPhone, hotNoPhone, called, zalo, notBuy, phoneRate, productCount };
}

function dashboardSelected(value, current) {
    return String(value) === String(current) ? "selected" : "";
}

function dashboardGetViewValue(req, mode) {
    if (mode === "today") return "today";
    if (mode === "yesterday") return "yesterday";
    if (mode === "hot") return "hot";
    if (req.query.hours) return `hours:${req.query.hours}`;
    if (req.query.date) return "date";
    return "all";
}

const ACTIVE_AD_NAMES = {
    "120246124254580301": "Giải pháp nội thất + xả kho",
    "120246119912860301": "Phòng tắm - sen vòi",
    "120246120500220301": "Sen vòi cao cấp",
    "120245962675930301": "Tủ - chậu - lavabo",
    "120246120761840301": "Phòng tắm - bồn tắm cao cấp",
    "120246073187320301": "Bồn tắm",
    "120246073187330301": "TBVS01",
    "120245910422410301": "Cửa Hàng 2",
    "120245911596200301": "Cửa hàng",
    "120245787797740301": "GUKA - Tổng hợp",
    "120245792695640301": "TBVS02"
};

const ACTIVE_AD_IDS = Object.keys(ACTIVE_AD_NAMES);

function dashboardRate(part, total) {
    if (!total) return "0.0";
    return ((part / total) * 100).toFixed(1);
}

function dashboardBuildActiveAdsStats(report) {
    const map = {};

    for (const adId of ACTIVE_AD_IDS) {
        map[adId] = {
            adId,
            name: ACTIVE_AD_NAMES[adId] || `QC ${adId}`,
            total: 0,
            hasPhone: 0,
            noPhone: 0,
            zalo: 0,
            called: 0,
            hotNoPhone: 0,
            productCount: {}
        };
    }

    for (const item of report) {
        const activeIds = Array.isArray(item.ad_ids)
            ? item.ad_ids.filter(id => ACTIVE_AD_IDS.includes(String(id)))
            : [];

        if (activeIds.length === 0) continue;

        for (const adId of activeIds) {
            const row = map[adId];
            if (!row) continue;

            row.total++;
            if (item.has_phone) row.hasPhone++;
            if (!item.has_phone) row.noPhone++;
            if (item.tags.includes("Zalo")) row.zalo++;
            if (item.tags.includes("Đã Gọi")) row.called++;
            if (item.hot_lead && !item.has_phone) row.hotNoPhone++;

            const product = item.product || "Khác";
            row.productCount[product] = (row.productCount[product] || 0) + 1;
        }
    }

    return Object.values(map)
        .sort((a, b) => b.hasPhone - a.hasPhone || b.total - a.total);
}

function dashboardProductSummary(productCount) {
    return Object.entries(productCount || {})
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}: ${count}`)
        .join(", ") || "Chưa rõ";
}

function dashboardAdRowClass(row) {
    const rate = row.total ? (row.hasPhone / row.total) * 100 : 0;
    if (rate >= 35) return "row-good";
    if (rate >= 20) return "row-mid";
    return "row-low";
}

function dashboardRenderHtml({ title, limit, fullTotal, report, req, mode }) {
    const stats = dashboardBuildStats(report);
    const adsStats = dashboardBuildActiveAdsStats(report);
    const currentLimit = String(limit || 500);
    const currentProduct = dashboardProductParamFromName(dashboardNormalizeProduct(req.query.product || "all"));
    const currentView = dashboardGetViewValue(req, mode);
    const currentDate = req.query.date || dashboardTodayKeyVN(0);

    const adsRows = adsStats.map((x, index) => `
        <tr class="${dashboardAdRowClass(x)}">
            <td>${index + 1}</td>
            <td><b>${dashboardEscapeHtml(x.name)}</b><br><span>${dashboardEscapeHtml(x.adId)}</span></td>
            <td><b>${x.total}</b></td>
            <td><b>${x.hasPhone}</b><br><span>${dashboardRate(x.hasPhone, x.total)}%</span></td>
            <td>${x.noPhone}</td>
            <td><b>${x.zalo}</b><br><span>${dashboardRate(x.zalo, x.total)}%</span></td>
            <td>${x.called}</td>
            <td>${x.hotNoPhone}</td>
            <td>${dashboardEscapeHtml(dashboardProductSummary(x.productCount))}</td>
        </tr>
    `).join("");

    const hotRows = stats.hotNoPhone.slice(0, 50).map((x, index) => `
        <tr class="row-hot">
            <td>${index + 1}</td>
            <td><b>${dashboardEscapeHtml(x.name)}</b><br><span>${dashboardEscapeHtml(x.conversation_id)}</span></td>
            <td>${dashboardEscapeHtml(x.product)}</td>
            <td>${dashboardEscapeHtml(x.updated_at || "")}</td>
            <td>${dashboardEscapeHtml(x.snippet || "")}</td>
        </tr>
    `).join("");

    const phoneRows = report
        .filter(x => x.has_phone)
        .slice(0, 50)
        .map((x, index) => `
            <tr class="row-phone">
                <td>${index + 1}</td>
                <td><b>${dashboardEscapeHtml(x.name)}</b></td>
                <td><b>${dashboardEscapeHtml(x.phones.join(", ") || "Có số nhưng chưa đọc được số")}</b></td>
                <td>${dashboardEscapeHtml(x.product)}</td>
                <td>${dashboardEscapeHtml(x.tags.join(", ") || "Chưa tag")}</td>
            </tr>
        `).join("");

    const noPhoneRows = report
        .filter(x => !x.has_phone)
        .slice(0, 50)
        .map((x, index) => `
            <tr class="row-normal">
                <td>${index + 1}</td>
                <td><b>${dashboardEscapeHtml(x.name)}</b><br><span>${dashboardEscapeHtml(x.conversation_id)}</span></td>
                <td>${dashboardEscapeHtml(x.product)}</td>
                <td>${dashboardEscapeHtml(x.updated_at || "")}</td>
                <td>${dashboardEscapeHtml(x.snippet || "")}</td>
            </tr>
        `).join("");

    return `<!doctype html>
<html lang="vi">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dashboard Pancake - Ánh Dương</title>
    <style>
        body { margin: 0; font-family: "Times New Roman", Times, serif; font-size: 14px; background: #f8fafc; color: #111827; }
        .wrap { max-width: 1280px; margin: 0 auto; padding: 18px; }
        .header { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 16px; }
        .header h1 { margin: 0; font-size: 26px; }
        .header p { margin: 6px 0 0; color: #64748b; }
        .btns a { display: inline-block; margin-left: 8px; padding: 10px 12px; border-radius: 10px; background: #2563eb; color: white; text-decoration: none; font-size: 14px; }
        .btns a.red { background: #ef4444; }
        .btns a.green { background: #16a34a; }
        .filters { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; background: #ffffff; padding: 14px; border-radius: 16px; box-shadow: 0 1px 4px rgba(15,23,42,.08); margin-bottom: 14px; border: 1px solid #e2e8f0; }
        .filter label { display:block; font-size: 13px; color: #64748b; margin-bottom: 5px; }
        .filter select, .filter input { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 14px; background: #f8fafc; font-family: "Times New Roman", Times, serif; }
        .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
        .card { background: #ffffff; border-radius: 16px; padding: 16px; box-shadow: 0 1px 4px rgba(15,23,42,.08); border: 1px solid #e2e8f0; }
        .card.blue { background: #eff6ff; border-color: #bfdbfe; }
        .card.green { background: #ecfdf5; border-color: #bbf7d0; }
        .card.red { background: #fef2f2; border-color: #fecaca; }
        .card.orange { background: #fff7ed; border-color: #fed7aa; }
        .card.pink { background: #fdf2f8; border-color: #fbcfe8; }
        .card.gray { background: #f8fafc; border-color: #cbd5e1; }
        .card .label { color: #475569; font-size: 14px; }
        .card .num { margin-top: 8px; font-size: 30px; font-weight: 800; color: #0f172a; }
        .section { margin-top: 16px; }
        .section h2 { margin: 0 0 10px; font-size: 20px; }
        .table-wrap { overflow-x: auto; border-radius: 16px; box-shadow: 0 1px 4px rgba(15,23,42,.08); border: 1px solid #e2e8f0; }
        table { width: 100%; border-collapse: collapse; background: white; min-width: 900px; }
        th, td { padding: 11px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; font-size: 14px; line-height: 1.35; }
        th { background: #e0f2fe; color: #0f172a; font-weight: 800; position: sticky; top: 0; }
        td span { color: #64748b; font-size: 13px; }
        tbody tr:nth-child(even) { background: #f8fafc; }
        .row-good { background: #dcfce7 !important; }
        .row-mid { background: #fef9c3 !important; }
        .row-low { background: #ffe4e6 !important; }
        .row-hot { background: #ffedd5 !important; }
        .row-phone { background: #ecfdf5 !important; }
        .row-normal { background: #f8fafc; }
        .products { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
        .product { background: #ffffff; border-radius: 14px; padding: 13px; box-shadow: 0 1px 4px rgba(15,23,42,.08); border: 1px solid #e2e8f0; }
        .product:nth-child(1) { background:#eff6ff; }
        .product:nth-child(2) { background:#ecfdf5; }
        .product:nth-child(3) { background:#fdf2f8; }
        .product:nth-child(4) { background:#fff7ed; }
        .product:nth-child(5) { background:#f5f3ff; }
        .product:nth-child(6) { background:#f1f5f9; }
        .product b { display:block; font-size: 22px; margin-top: 6px; }
        .notice { background: #fff7ed; border: 1px solid #fed7aa; padding: 12px; border-radius: 12px; margin-top: 12px; color: #9a3412; }
        .legend { display:flex; flex-wrap:wrap; gap:8px; margin: 8px 0 10px; color:#475569; font-size:13px; }
        .chip { padding:6px 10px; border-radius:999px; border:1px solid #e2e8f0; background:white; }
        .chip.good { background:#dcfce7; }
        .chip.mid { background:#fef9c3; }
        .chip.low { background:#ffe4e6; }
        @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } .products { grid-template-columns: repeat(2, 1fr); } .filters { grid-template-columns: repeat(1, 1fr); } .header { display: block; } .btns { margin-top: 12px; } .btns a { margin: 4px 4px 0 0; } th, td { font-size: 12px; padding: 9px; } }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="header">
            <div>
                <h1>📊 Dashboard Pancake - Ánh Dương</h1>
                <p>${dashboardEscapeHtml(title)} | Đã lấy ${fullTotal}/${limit} hội thoại | Đang hiển thị ${stats.total} hội thoại | Cập nhật: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
            </div>
            <div class="btns">
                <a class="green" href="/dashboard-today?limit=${currentLimit}">Hôm nay</a>
                <a href="/dashboard-yesterday?limit=${currentLimit}">Hôm qua</a>
                <a href="/dashboard?hours=24&limit=${currentLimit}">24 giờ</a>
                <a href="/dashboard?limit=${currentLimit}">Gần nhất</a>
                <a class="red" href="/dashboard-hot?limit=${currentLimit}">Khách nóng</a>
                <a href="/pancake-report-text?limit=${currentLimit}">Bản text</a>
            </div>
        </div>

        <div class="filters">
            <div class="filter">
                <label>Số hội thoại</label>
                <select id="limitSelect" onchange="applyDashboardFilters()">
                    <option value="100" ${dashboardSelected("100", currentLimit)}>100 gần nhất</option>
                    <option value="200" ${dashboardSelected("200", currentLimit)}>200 gần nhất</option>
                    <option value="300" ${dashboardSelected("300", currentLimit)}>300 gần nhất</option>
                    <option value="500" ${dashboardSelected("500", currentLimit)}>500 gần nhất</option>
                </select>
            </div>
            <div class="filter">
                <label>Chế độ xem</label>
                <select id="viewSelect" onchange="applyDashboardFilters()">
                    <option value="all" ${dashboardSelected("all", currentView)}>Tổng quan gần nhất</option>
                    <option value="today" ${dashboardSelected("today", currentView)}>Hôm nay</option>
                    <option value="yesterday" ${dashboardSelected("yesterday", currentView)}>Hôm qua</option>
                    <option value="hours:24" ${dashboardSelected("hours:24", currentView)}>24 giờ gần nhất</option>
                    <option value="hours:48" ${dashboardSelected("hours:48", currentView)}>48 giờ gần nhất</option>
                    <option value="hot" ${dashboardSelected("hot", currentView)}>Khách nóng chưa có số</option>
                    <option value="date" ${dashboardSelected("date", currentView)}>Chọn ngày cụ thể</option>
                </select>
            </div>
            <div class="filter">
                <label>Ngày cụ thể</label>
                <input id="dateInput" type="date" value="${dashboardEscapeHtml(currentDate)}" onchange="document.getElementById('viewSelect').value='date'; applyDashboardFilters();" />
            </div>
            <div class="filter">
                <label>Sản phẩm</label>
                <select id="productSelect" onchange="applyDashboardFilters()">
                    <option value="all" ${dashboardSelected("all", currentProduct)}>Tất cả</option>
                    <option value="quat" ${dashboardSelected("quat", currentProduct)}>Quạt</option>
                    <option value="thiet_bi_ve_sinh" ${dashboardSelected("thiet_bi_ve_sinh", currentProduct)}>Thiết bị vệ sinh</option>
                    <option value="combo" ${dashboardSelected("combo", currentProduct)}>Combo phòng tắm</option>
                    <option value="bep" ${dashboardSelected("bep", currentProduct)}>Bếp</option>
                    <option value="bon_tam" ${dashboardSelected("bon_tam", currentProduct)}>Bồn tắm</option>
                    <option value="khac" ${dashboardSelected("khac", currentProduct)}>Khác</option>
                </select>
            </div>
            <div class="filter">
                <label>Bảng quảng cáo</label>
                <select id="adsTableSelect" onchange="toggleAdsTable()">
                    <option value="show">Hiện bảng QC</option>
                    <option value="hide">Ẩn bảng QC</option>
                </select>
            </div>
            <div class="filter">
                <label>Thao tác</label>
                <select onchange="if(this.value) window.location.href=this.value">
                    <option value="">Mở nhanh...</option>
                    <option value="/dashboard?limit=${currentLimit}">Dashboard</option>
                    <option value="/pancake-report-text?limit=${currentLimit}">Bản text</option>
                    <option value="/pancake-report?limit=${currentLimit}">JSON</option>
                </select>
            </div>
        </div>

        <div class="notice">Phần <b>Hiệu quả theo quảng cáo</b> luôn hiển thị đủ 11 quảng cáo đang hoạt động đã khai báo trong hệ thống, kể cả quảng cáo chưa có tin nhắn.</div>

        <div class="grid">
            <div class="card blue"><div class="label">Tổng hội thoại</div><div class="num">${stats.total}</div></div>
            <div class="card green"><div class="label">Có số điện thoại</div><div class="num">${stats.hasPhone}</div></div>
            <div class="card red"><div class="label">Chưa có số</div><div class="num">${stats.noPhone}</div></div>
            <div class="card orange"><div class="label">Khách nóng chưa có số</div><div class="num">${stats.hotNoPhone.length}</div></div>
            <div class="card pink"><div class="label">Tỷ lệ lấy số</div><div class="num">${stats.phoneRate}%</div></div>
            <div class="card gray"><div class="label">Đã gọi</div><div class="num">${stats.called}</div></div>
            <div class="card blue"><div class="label">Có tag Zalo</div><div class="num">${stats.zalo}</div></div>
            <div class="card red"><div class="label">Không mua</div><div class="num">${stats.notBuy}</div></div>
        </div>

        <div class="section" id="ads">
            <h2>📈 Hiệu quả theo quảng cáo đang hoạt động</h2>
            <div class="legend">
                <span class="chip good">Xanh: tỷ lệ lấy SĐT ≥ 35%</span>
                <span class="chip mid">Vàng: 20% - 34.9%</span>
                <span class="chip low">Hồng: dưới 20%</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>#</th><th>Quảng cáo</th><th>Hội thoại</th><th>Có SĐT</th><th>Chưa SĐT</th><th>Zalo</th><th>Đã gọi</th><th>Khách nóng chưa số</th><th>Sản phẩm chính</th></tr></thead>
                    <tbody>${adsRows || `<tr><td colspan="9">Chưa có dữ liệu từ các quảng cáo đang hoạt động</td></tr>`}</tbody>
                </table>
            </div>
        </div>

        <div class="section">
            <h2>Phân loại sản phẩm</h2>
            <div class="products">
                <div class="product">Quạt <b>${stats.productCount.quat}</b></div>
                <div class="product">Thiết bị vệ sinh <b>${stats.productCount.thietBiVeSinh}</b></div>
                <div class="product">Combo phòng tắm <b>${stats.productCount.comboPhongTam}</b></div>
                <div class="product">Bếp <b>${stats.productCount.bep}</b></div>
                <div class="product">Bồn tắm <b>${stats.productCount.bonTam}</b></div>
                <div class="product">Khác <b>${stats.productCount.khac}</b></div>
            </div>
        </div>

        <div class="section">
            <h2>🔥 Khách nóng chưa có số</h2>
            <div class="table-wrap"><table>
                <thead><tr><th>#</th><th>Khách</th><th>Sản phẩm</th><th>Cập nhật</th><th>Nội dung gần nhất</th></tr></thead>
                <tbody>${hotRows || `<tr><td colspan="5">Không có</td></tr>`}</tbody>
            </table></div>
        </div>

        <div class="section">
            <h2>📞 Khách đã có số</h2>
            <div class="table-wrap"><table>
                <thead><tr><th>#</th><th>Khách</th><th>Số điện thoại</th><th>Sản phẩm</th><th>Tag</th></tr></thead>
                <tbody>${phoneRows || `<tr><td colspan="5">Không có</td></tr>`}</tbody>
            </table></div>
        </div>

        <div class="section">
            <h2>🕒 Khách chưa có số gần nhất</h2>
            <div class="table-wrap"><table>
                <thead><tr><th>#</th><th>Khách</th><th>Sản phẩm</th><th>Cập nhật</th><th>Nội dung gần nhất</th></tr></thead>
                <tbody>${noPhoneRows || `<tr><td colspan="5">Không có</td></tr>`}</tbody>
            </table></div>
        </div>
    </div>
<script>
function toggleAdsTable() {
    const select = document.getElementById('adsTableSelect');
    const section = document.getElementById('ads');
    if (!select || !section) return;
    section.style.display = select.value === 'hide' ? 'none' : 'block';
}

function applyDashboardFilters() {
    const limit = document.getElementById('limitSelect').value;
    const view = document.getElementById('viewSelect').value;
    const product = document.getElementById('productSelect').value;
    const date = document.getElementById('dateInput').value;
    let path = '/dashboard';
    const params = new URLSearchParams();
    params.set('limit', limit);
    if (product && product !== 'all') params.set('product', product);

    if (view === 'today') {
        path = '/dashboard-today';
    } else if (view === 'yesterday') {
        path = '/dashboard-yesterday';
    } else if (view === 'hot') {
        path = '/dashboard-hot';
    } else if (view && view.startsWith('hours:')) {
        params.set('hours', view.split(':')[1]);
    } else if (view === 'date') {
        if (date) params.set('date', date);
    }

    window.location.href = path + '?' + params.toString();
}
</script>
</body>
</html>`;
}

async function dashboardHandler(req, res, mode = "all") {
    try {
        const limit = req.query.limit || 500;
        const conversations = await pancakeFetchConversations(limit);
        const fullReport = conversations.map(pancakeBuildCustomerRow);
        const filtered = dashboardFilterReport(fullReport, req, mode);
        res.type('html').send(dashboardRenderHtml({
            title: filtered.title,
            limit,
            fullTotal: fullReport.length,
            report: filtered.report,
            req,
            mode
        }));
    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).type('text/plain').send(`Lỗi khi mở dashboard: ${error.message}`);
    }
}

router.get('/dashboard', async (req, res) => {
    await dashboardHandler(req, res, "all");
});

router.get('/dashboard-today', async (req, res) => {
    await dashboardHandler(req, res, "today");
});

router.get('/dashboard-yesterday', async (req, res) => {
    await dashboardHandler(req, res, "yesterday");
});

router.get('/dashboard-hot', async (req, res) => {
    req.query.hours = req.query.hours || "24";
    await dashboardHandler(req, res, "hot");
});



    return router;
}

module.exports = createDashboardRoutes;
