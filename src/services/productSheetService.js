// ===== AIGUKA PRODUCT SHEET ENGINE V1 =====
// Mục tiêu: đọc Google Sheet Master để bot chỉ báo khoảng giá min -> max,
// không bao giờ báo giá cụ thể từng mẫu. Ảnh hiện vẫn dùng gallery có sẵn trong code.

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

function pick(row, keys) {
    for (const key of keys) {
        const normalized = normalizeKey(key);
        if (Object.prototype.hasOwnProperty.call(row, normalized)) {
            const value = String(row[normalized] || "").trim();
            if (value) return value;
        }
    }
    return "";
}

function parsePriceNumber(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;

    // Hỗ trợ 3.950.000, 3,95 triệu, 3950000, 3.95tr
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
    const minText = formatPriceShort(row.price_min);
    const maxText = formatPriceShort(row.price_max);

    if (minText && maxText && minText !== maxText) return `khoảng ${minText} đến ${maxText}`;
    if (minText && maxText && minText === maxText) return `khoảng ${minText}`;
    if (minText) return `từ khoảng ${minText}`;
    if (maxText) return `dưới khoảng ${maxText}`;
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

        const category = pick(raw, ["Danh mục", "Danh muc", "Category"]);
        const group = pick(raw, ["Nhóm sản phẩm", "Nhom san pham", "Tên nhóm", "Ten nhom", "Sản phẩm", "San pham"]);
        const path = pick(raw, ["Đường dẫn", "Duong dan", "Folder", "Path"]);
        const priceMin = pick(raw, ["Giá thấp nhất", "Gia thap nhat", "Giá min", "Gia min", "Min", "Price min"]);
        const priceMax = pick(raw, ["Giá cao nhất", "Gia cao nhat", "Giá max", "Gia max", "Max", "Price max"]);
        const note = pick(raw, ["Ghi chú", "Ghi chu", "Note"]);

        if (!category && !group && !path) continue;

        result.push({
            category,
            group,
            path,
            price_min: priceMin,
            price_max: priceMax,
            note,
            search_text: normalizeText(`${category} ${group} ${path} ${note}`)
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

    // Từ khóa cụ thể trong câu khách hỏi: màu, số cánh, nhóm sản phẩm...
    const keywords = [
        "10 canh", "8 canh", "5 canh", "6 canh", "gold", "vang", "den", "black", "nau", "brown", "wood", "go",
        "combo", "ban chay", "dep", "cao cap", "lavabo", "bon cau", "bon tam", "sen", "voi", "bep", "hut mui", "chau"
    ];

    for (const kw of keywords) {
        if (query.includes(kw) && haystack.includes(kw)) score += 8;
    }

    // Nếu tên nhóm/path xuất hiện gần đúng trong query thì cộng thêm.
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

    // Fallback theo productType nếu không có từ khóa chi tiết.
    const terms = productTypeToCategoryTerms(productType).map(normalizeText);
    return rows.find(row => terms.some(term => row.search_text.includes(term))) || null;
}

function buildPriceRangeReply(row, productType = "") {
    const rangeText = buildRangeText(row);
    const label = row?.group || row?.category || "dòng này";

    if (!rangeText) {
        return `Dạ ${label} bên em có nhiều mẫu và phân khúc khác nhau. Anh để lại SĐT/Zalo, bên em gửi mẫu phù hợp và báo khoảng giá chính xác hơn cho anh nhé?`;
    }

    return `Dạ ${label} bên em hiện có nhiều phiên bản, giá ${rangeText} tùy mẫu và chương trình tại thời điểm tư vấn ạ. Anh để lại SĐT/Zalo, bên em gửi thêm mẫu phù hợp và báo chi tiết cho anh nhé?`;
}

function buildProductIntroWithPrice(row, productType = "") {
    const rangeText = buildRangeText(row);
    const label = row?.group || row?.category || "một số mẫu";

    if (rangeText) {
        return `Dạ em gửi anh vài mẫu ${label} nổi bật để tham khảo nhé. Dòng này giá ${rangeText} tùy mẫu và chương trình ạ.`;
    }

    return `Dạ em gửi anh vài mẫu ${label} nổi bật để tham khảo nhé.`;
}

module.exports = {
    loadProductRows,
    findBestProductRow,
    buildPriceRangeReply,
    buildProductIntroWithPrice,
    buildRangeText,
    formatPriceShort
};
