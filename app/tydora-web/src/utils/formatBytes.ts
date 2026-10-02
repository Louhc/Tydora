/**
 * 字节数 → 人类可读文本（1024 进制）。回收站配额、条目大小等处共用。
 * 小于 1KB 时不带小数（"512 B"），其余保留一位（"1.5 MB"）。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}
