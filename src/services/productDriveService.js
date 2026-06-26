// ===== AIGUKA PRODUCT DRIVE ENGINE V1 / v3.9.6 =====
// Đọc ảnh từ Google Drive theo đường dẫn con người nhập trong Google Sheet.
// Sheet dùng path dễ hiểu: fan/10 cánh/Gold hoặc Products/Fan/10 cánh/Gold.
// Server tự resolve folder -> file qua Google Drive API nếu có cấu hình.

const GOOGLE_DRIVE_PRODUCTS_ROOT_ID = process.env.GOOGLE_DRIVE_PRODUCTS_ROOT_ID || process.env.PRODUCTS_DRIVE_ROOT_ID || "";
const GOOGLE_DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_API_KEY || "";
const DRIVE_CACHE_TTL_MS = Number(process.env.GOOGLE_DRIVE_CACHE_TTL_MS || 10 * 60 * 1000);

const folderIdCache = new Map();
const fileListCache = new Map();

function stripVietnamese(str = "") {
    return String(str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D");
}

function normalizePathSegment(str = "") {
    return stripVietnamese(str).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeDrivePath(input = "") {
    return String(input || "")
        .replace(/\\/g, "/")
        .split("/")
        .map(x => x.trim())
        .filter(Boolean)
        .filter(x => normalizePathSegment(x) !== "products");
}

function driveReady() {
    return Boolean(GOOGLE_DRIVE_PRODUCTS_ROOT_ID && GOOGLE_DRIVE_API_KEY);
}

function escapeDriveQueryValue(value = "") {
    return String(value || "").replace(/'/g, "\\'");
}

async function driveListChildren(parentId, { folderOnly = false } = {}) {
    if (!driveReady()) return [];
    const qParts = [`'${escapeDriveQueryValue(parentId)}' in parents`, "trashed = false"];
    if (folderOnly) qParts.push("mimeType = 'application/vnd.google-apps.folder'");
    const params = new URLSearchParams({
        key: GOOGLE_DRIVE_API_KEY,
        q: qParts.join(" and "),
        fields: "files(id,name,mimeType,webContentLink,webViewLink,thumbnailLink)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
    });
    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Google Drive API ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json();
    return Array.isArray(data.files) ? data.files : [];
}

async function resolveFolderIdByPath(folderPath = "", { force = false } = {}) {
    if (!driveReady()) return null;
    const segments = normalizeDrivePath(folderPath);
    if (!segments.length) return GOOGLE_DRIVE_PRODUCTS_ROOT_ID;

    const cacheKey = segments.map(normalizePathSegment).join("/");
    const cached = folderIdCache.get(cacheKey);
    const now = Date.now();
    if (!force && cached && now - cached.time < DRIVE_CACHE_TTL_MS) return cached.id;

    let parentId = GOOGLE_DRIVE_PRODUCTS_ROOT_ID;
    const resolved = [];
    for (const segment of segments) {
        const children = await driveListChildren(parentId, { folderOnly: true });
        const wanted = normalizePathSegment(segment);
        const found = children.find(f => normalizePathSegment(f.name) === wanted);
        if (!found) return null;
        parentId = found.id;
        resolved.push(found.name);
    }

    folderIdCache.set(cacheKey, { id: parentId, time: now, resolvedPath: resolved.join("/") });
    return parentId;
}

function isImageFile(file) {
    const mime = String(file?.mimeType || "").toLowerCase();
    const name = String(file?.name || "").toLowerCase();
    return mime.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif)$/i.test(name);
}

function driveImageUrl(fileId) {
    // URL trực tiếp đủ ổn cho Messenger nếu folder/file đã share công khai.
    return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
}

async function listProductImagesByPath(folderPath = "", { force = false } = {}) {
    if (!driveReady() || !folderPath) return [];
    const normalized = normalizeDrivePath(folderPath).map(normalizePathSegment).join("/");
    const cached = fileListCache.get(normalized);
    const now = Date.now();
    if (!force && cached && now - cached.time < DRIVE_CACHE_TTL_MS) return cached.items;

    const folderId = await resolveFolderIdByPath(folderPath, { force });
    if (!folderId) return [];

    const files = await driveListChildren(folderId, { folderOnly: false });
    const items = files
        .filter(isImageFile)
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "vi", { numeric: true }))
        .map((file, index) => ({
            id: file.id,
            title: String(file.name || `Ảnh ${index + 1}`).replace(/\.[^.]+$/, ""),
            image_url: driveImageUrl(file.id),
            webViewLink: file.webViewLink || "",
            name: file.name || ""
        }));

    fileListCache.set(normalized, { time: now, items, folderId });
    return items;
}

async function debugDrivePath(folderPath = "", { force = false } = {}) {
    const ready = driveReady();
    if (!ready) {
        return {
            ready: false,
            error: "Thiếu GOOGLE_DRIVE_PRODUCTS_ROOT_ID hoặc GOOGLE_DRIVE_API_KEY",
            folderPath,
            count: 0,
            images: []
        };
    }
    const folderId = await resolveFolderIdByPath(folderPath, { force });
    const images = folderId ? await listProductImagesByPath(folderPath, { force }) : [];
    return {
        ready,
        folderPath,
        folderId,
        count: images.length,
        images: images.slice(0, 20)
    };
}

module.exports = {
    listProductImagesByPath,
    debugDrivePath,
    driveReady,
    normalizeDrivePath
};
