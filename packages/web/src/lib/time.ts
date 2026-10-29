import { useLive } from "../live.ts";

/** 浏览器（设备）自己的时区。 */
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 当前生效的时区：设置里选了就用设置的（所有设备一致），否则跟随设备。 */
export function useTimeZone(): string {
  const { overview } = useLive();
  return overview?.settings.timeZone ?? deviceTimeZone();
}

/** 某个时刻在指定时区里的年月日，用于判断是不是「今天」。 */
const dayKey = (d: Date, timeZone: string) => d.toLocaleDateString("en-CA", { timeZone });

/** 消息时间：今天只显示 14:03，其他日子显示 10月27日 14:03（24 小时制）。 */
export function formatMessageTime(iso: string | undefined, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const hm = d.toLocaleTimeString("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  if (dayKey(d, timeZone) === dayKey(new Date(), timeZone)) return hm;
  return `${d.toLocaleDateString("zh-CN", { timeZone, month: "long", day: "numeric" })} ${hm}`;
}

/** 完整日期时间：2026/10/28 14:03。 */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 时区与 UTC 的偏移，如 UTC+8、UTC-7。 */
export function utcOffset(timeZone: string, at = new Date()): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return (part ?? "GMT").replace("GMT", "UTC").replace(/^UTC$/, "UTC+0");
}

/** 常用时区，排在列表最前面。 */
export const COMMON_TIME_ZONES: { zone: string; label: string }[] = [
  { zone: "Asia/Shanghai", label: "北京 / 上海" },
  { zone: "Asia/Hong_Kong", label: "香港" },
  { zone: "Asia/Taipei", label: "台北" },
  { zone: "Asia/Tokyo", label: "东京" },
  { zone: "Asia/Singapore", label: "新加坡" },
  { zone: "America/Los_Angeles", label: "洛杉矶（美西）" },
  { zone: "America/New_York", label: "纽约（美东）" },
  { zone: "Europe/London", label: "伦敦" },
  { zone: "Europe/Berlin", label: "柏林" },
  { zone: "UTC", label: "UTC" },
];

export function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return COMMON_TIME_ZONES.map((z) => z.zone);
  }
}
