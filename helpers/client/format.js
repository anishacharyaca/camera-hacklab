export function fmtBytes(bytes) {
  if (bytes == null) return "0";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function renderList(items, emptyText) {
  if (!items || !items.length) return emptyText;
  return items.map((item) => `<div class="sd-item">${item}</div>`).join("");
}

export function extractSdDisplay(payload) {
  if (!payload) return "No response";
  if (payload.json) {
    return JSON.stringify(payload.json, null, 2);
  }
  return payload.raw_text || "No response";
}

export function todayYmd() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}
