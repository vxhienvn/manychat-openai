// ===== AIGUKA PRODUCT SHEET ENGINE V2 / v3.9 =====
// Mục tiêu:
// - Đọc Google Sheet Master theo cấu trúc thật của showroom:
//   A Folder | B Tên sản phẩm | C số cánh | D màu | E giá thấp nhất(VNĐ) | F giá cao nhất(VNĐ)
// - Bot chỉ báo khoảng giá min -> max, không báo giá cụ thể từng mẫu/model.
// - Google Sheet là bản đồ tư vấn; Google Drive là kho ảnh; Sales là người chốt.

const DEFAULT_PRODUCT_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1HZH7ajJj5L2nZF77TP42vc60sLdBDgre0if8i1WFMj4/export?format=csv&gid=0";

const PRODUCT_SHEET_CSV_URL = process.env.PRODUCT_SHEET_CSV_URL || DEFAULT_PRODUCT_SHEET_CSV_URL;
const PRODUCT_SHEET_CACHE_TTL_MS = Number(process.env.PRODUCT_SHEET_CACHE_TTL_MS || 5 * 60 * 1000);

let productSheetCache = {
    fetchedAt: 0,
    rows: [],
    error: null
};

function stripVietnamese(str = "") {
    return String(str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D");
}

function normalizeKey(str = "") {
    return stripVietnamese(str)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function normalizeText(str = "") {
    return stripVietnamese(str).toLowerCase().replace(/\s+/g, " ").trim();
}

function parseCsv(text = "") {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '"') {
            if (inQuotes && next === '"') {
                cell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (ch === ',' && !inQuotes) {
            row.push(cell);
            cell = "";
            continue;
        }

        if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && next === '\n') i++;
            row.push(cell);
            if (row.some(v => String(v || "").trim() !== "")) rows.push(row);
            row = [];
            cell = "";
            continue;
        }

        cell += ch;
    }

    row.push(cell);
    if (row.some(v => String(v || "").trim() !== "")) rows.push(row);
    return rows;
}

function getValue(row, normalizedHeader) {
    const value = row[normalizedHeader];
    return String(value || "").trim();
}

function pick(row, keys) {
    const normalizedKeys = keys.map(normalizeKey);

    // 1) Ưu tiên khớp chính xác.
    for (const key of normalizedKeys) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
            const value = getValue(row, key);
            if (value) return value;
        }
    }

    // 2) Chấp nhận tiêu đề có thêm hậu tố như: gia_thap_nhat_vnđ -> gia_thap_nhat.
    for (const wanted of normalizedKeys) {
        for (const actual of Object.keys(row)) {
            if (actual === wanted || actual.startsWith(`${wanted}_`) || actual.includes(wanted)) {
                const value = getValue(row, actual);
                if (value) return value;
            }
        }
    }

    return "";
}

function parsePriceNumber(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;

    // Hỗ trợ: 3950000, 3.950.000, 3,95 triệu, 3.95tr, 600.000 đ.
    const lower = normalizeText(raw).replace(/,/g, ".");
    const hasMillion = lower.includes("trieu") || lower.includes("tr");
    const digitsAndDots = lower.replace(/[^0-9.]/g, "");
    if (!digitsAndDots) return null;

    if (hasMillion && digitsAndDots.includes(".")) {
        const n = Number(digitsAndDots);
        return Number.isFinite(n) ? Math.round(n * 1000000) : null;
    }

    const digits = raw.replace(/[^0-9]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    if (!Number.isFinite(n)) return null;

    // Nếu nhập 3 hoặc 8, hiểu là triệu.
    if (n > 0 && n < 1000) return n * 1000000;
    return n;
}

function formatPriceShort(value) {
    const n = parsePriceNumber(value);
    if (!n) return "";

    const million = n / 1000000;
    const text = Number.isInteger(million)
        ? String(million)
        : String(Math.round(million * 100) / 100).replace(".", ",");
    return `${text} triệu`;
}

function buildRangeText(row) {
    if (!row) return "";

    const minText = formatPriceShort(row.price_min);
    const maxText = formatPriceShort(row.price_max);

    if (minText && maxText && minText !== maxText) return `khoảng ${minText} đến ${maxText}`;
    if (minText && maxText && minText === maxText) return `khoảng ${minText}`;
    if (minText) return `từ khoảng ${minText}`;
    if (maxText) return `dưới khoảng ${maxText}`;
    return "";
}

function inferCategoryFromPath(path = "") {
    const first = normalizeText(String(path).split(/[\\/]/)[0] || "");
    if (first.includes("fan") || first.includes("quat")) return "Fan";
    if (first.includes("bathroom") || first.includes("phong tam") || first.includes("lavabo") || first.includes("bon") || first.includes("sen")) return "Bathroom";
    if (first.includes("kitchen") || first.includes("bep") || first.includes("chau")) return "Kitchen";
    if (first.includes("lighting") || first.includes("den")) return "Lighting";
    return "";
}

function normalizeProductRows(csvText) {
    const table = parseCsv(csvText);
    if (table.length < 2) return [];

    const headers = table[0].map(normalizeKey);
    const result = [];

    for (const values of table.slice(1)) {
        const raw = {};
        headers.forEach((header, index) => {
            raw[header] = String(values[index] || "").trim();
        });

        // Sheet hiện tại của showroom:
        // A Folder | B Tên sản | C số cánh | D màu | E giá thấp nhất(VNĐ) | F giá cao nhất(VNĐ) | G giá vận chuyển/lắp đặt (không dùng để tư vấn)
        const path = pick(raw, ["Folder", "Đường dẫn", "Duong dan", "Path"]);
        const group = pick(raw, ["Tên sản", "Ten san", "Tên sản phẩm", "Ten san pham", "Nhóm sản phẩm", "Nhom san pham", "Sản phẩm", "San pham"]);
        const blades = pick(raw, ["số cánh", "so canh", "cánh", "canh"]);
        const color = pick(raw, ["màu", "mau", "color"]);
        const priceMin = pick(raw, ["giá thấp nhất", "gia thap nhat", "giá min", "gia min", "min", "price min"]);
        const priceMax = pick(raw, ["giá cao nhất", "gia cao nhat", "giá max", "gia max", "max", "price max"]);
        const note = pick(raw, ["Ghi chú", "Ghi chu", "Note"]);
        let category = pick(raw, ["Danh mục", "Danh muc", "Category"]);
        if (!category) category = inferCategoryFromPath(path);

        // Bỏ qua dòng rỗng/không đủ dữ liệu thật. Tránh lấy nhầm dòng test như chỉ có chữ "tủ".
        if (!path && !priceMin && !priceMax) continue;
        if (!group && !path) continue;

        const labelParts = [group];
        if (blades) labelParts.push(`${blades} cánh`);
        if (color) labelParts.push(color);
        const displayLabel = labelParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

        result.push({
            category,
            group: group || displayLabel || category,
            path,
            blades,
            color,
            price_min: priceMin,
            price_max: priceMax,
            note,
            search_text: normalizeText(`${category} ${group} ${path} ${blades} ${color} ${note}`)
        });
    }

    return result;
}

async function loadProductRows({ force = false } = {}) {
    const now = Date.now();
    if (!force && productSheetCache.rows.length && now - productSheetCache.fetchedAt < PRODUCT_SHEET_CACHE_TTL_MS) {
        return productSheetCache.rows;
    }

    if (!PRODUCT_SHEET_CSV_URL) return [];

    try {
        const response = await fetch(PRODUCT_SHEET_CSV_URL);
        if (!response.ok) throw new Error(`Google Sheet HTTP ${response.status}`);
        const csvText = await response.text();
        const rows = normalizeProductRows(csvText);
        productSheetCache = { fetchedAt: now, rows, error: null };
        console.log(`Product Sheet loaded: ${rows.length} rows`);
        return rows;
    } catch (error) {
        productSheetCache.error = error.message;
        console.error("Product Sheet load error:", error.message);
        return productSheetCache.rows || [];
    }
}

function productTypeToCategoryTerms(productType = "") {
    const t = String(productType || "").toLowerCase();
    if (t === "fan") return ["fan", "quat", "quạt"];
    if (t === "kitchen") return ["kitchen", "bep", "bếp", "chau voi", "chậu vòi"];
    if (t === "faucet") return ["bathroom", "lavabo", "sen", "voi", "vòi", "chau", "chậu"];
    if (t === "combo" || t === "kitchen_bath") return ["bathroom", "combo", "phong tam", "phòng tắm", "tbvs", "thiet bi ve sinh"];
    return [];
}

function scoreProductRow(row, productType, message = "", history = "") {
    const haystack = row.search_text || "";
    const query = normalizeText(`${message} ${history}`).slice(-2000);
    let score = 0;

    for (const term of productTypeToCategoryTerms(productType)) {
        if (haystack.includes(normalizeText(term))) score += 12;
    }

    const keywords = [
        "10 canh", "8 canh", "5 canh", "6 canh", "gold", "vang", "guong", "den", "black", "nau", "brown", "wood", "go",
        "combo", "ban chay", "dep", "cao cap", "lavabo", "tu", "tu lavabo", "bon cau", "bet", "bon tam", "massage", "sen", "voi", "bep", "hut mui", "chau"
    ];

    for (const kw of keywords) {
        if (query.includes(kw) && haystack.includes(kw)) score += 8;
    }

    const groupWords = normalizeText(row.group).split(" ").filter(w => w.length >= 3);
    for (const w of groupWords) {
        if (query.includes(w)) score += 2;
    }

    return score;
}

async function findBestProductRow(productType, message = "", history = "") {
    const rows = await loadProductRows();
    if (!rows.length) return null;

    const scored = rows
        .map(row => ({ row, score: scoreProductRow(row, productType, message, history) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scored.length) return scored[0].row;

    const terms = productTypeToCategoryTerms(productType).map(normalizeText);
    return rows.find(row => terms.some(term => row.search_text.includes(term))) || null;
}

function buildPriceRangeReply(row, productType = "") {
    if (!row) {
        return "Dạ dòng này bên em có nhiều mẫu và phân khúc khác nhau. Anh/chị để lại SĐT/Zalo, bên em gửi vài mẫu phù hợp và sale báo khoảng giá đúng nhu cầu cho mình nhé?";
    }

    const rangeText = buildRangeText(row);
    const label = row?.group || row?.category || "dòng này";

    if (!rangeText) {
        return `Dạ ${label} bên em có nhiều mẫu và phân khúc khác nhau. Anh/chị để lại SĐT/Zalo, bên em gửi mẫu phù hợp và báo khoảng giá chính xác hơn cho mình nhé?`;
    }

    return `Dạ ${label} bên em hiện có nhiều phiên bản, giá ${rangeText} tùy mẫu và phân khúc ạ. Em chưa báo giá chi tiết từng mẫu trên Messenger để tránh sai chương trình. Anh/chị để lại SĐT/Zalo, sale bên em gửi đúng mẫu phù hợp và báo chi tiết cho mình nhé?`;
}

function buildProductIntroWithPrice(row, productType = "") {
    if (!row) return "Dạ em gửi anh/chị vài mẫu nổi bật để mình tham khảo trước nhé.";

    const rangeText = buildRangeText(row);
    const label = row?.group || row?.category || "một số mẫu";

    if (rangeText) {
        return `Dạ em gửi anh/chị vài mẫu ${label} nổi bật để tham khảo trước nhé. Dòng này giá ${rangeText} tùy mẫu và phân khúc ạ.`;
    }

    return `Dạ em gửi anh/chị vài mẫu ${label} nổi bật để tham khảo trước nhé.`;
}

module.exports = {
    loadProductRows,
    findBestProductRow,
    buildPriceRangeReply,
    buildProductIntroWithPrice,
    buildRangeText,
    formatPriceShort
};
