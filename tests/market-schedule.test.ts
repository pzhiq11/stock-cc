import { expect, it } from "vitest";
import { marketPollingActive, nextMarketPoll } from "@/lib/market/schedule";

const at = (time: string, date = "2026-11-17") => Date.parse(`${date}T${time}+08:00`);
it("starts at auction, pauses at lunch, resumes at 13:00 and stops at 15:00", () => {
  for (const time of ["09:15:00", "09:25:00", "09:30:00", "11:29:59", "13:00:00", "14:59:59"]) expect(marketPollingActive(at(time))).toBe(true);
  for (const time of ["09:14:59", "11:30:00", "12:30:00", "15:00:00", "23:00:00"]) expect(marketPollingActive(at(time))).toBe(false);
  expect(nextMarketPoll(at("10:00:00"), 1000)).toBe(at("10:00:01"));
});
it("fetches a settled snapshot once and then waits for the next opening", () => {
  expect(nextMarketPoll(at("11:30:00"), 1000)).toBe(at("11:31:00"));
  expect(nextMarketPoll(at("11:31:00"), 1000)).toBe(at("13:00:00"));
  expect(nextMarketPoll(at("15:00:00"), 1000)).toBe(at("15:01:00"));
  expect(nextMarketPoll(at("15:01:00"), 1000)).toBe(at("09:15:00", "2026-11-18"));
});
it("skips weekends and official holidays even while the local clock is within session hours", () => {
  expect(marketPollingActive(at("10:00:00", "2026-11-21"))).toBe(false);
  expect(marketPollingActive(at("10:00:00", "2026-10-01"))).toBe(false);
  expect(nextMarketPoll(at("16:00:00", "2026-09-30"), 1000)).toBe(at("09:15:00", "2026-10-08"));
});
it("uses a server-confirmed calendar and pauses when the year has not been verified", () => {
  const date = "2027-01-04", now = at("10:00:00", date);
  expect(marketPollingActive(now)).toBe(false);
  expect(marketPollingActive(now, { date, isTradingDay: true, next: "2027-01-05", provider: "verified" })).toBe(true);
  expect(marketPollingActive(at("10:00:00"), { date: "2026-11-17", isTradingDay: false, next: "2026-11-18", provider: "override" })).toBe(false);
});
it("only checks off-hours report completion while an actual job is running", () => {
  expect(nextMarketPoll(at("15:01:00"), 30000, null, true)).toBe(at("15:10:35"));
  expect(nextMarketPoll(at("15:11:00"), 30000, null, true, true)).toBe(at("15:11:30"));
  expect(nextMarketPoll(at("15:11:30"), 30000, null, true, false)).toBe(at("09:15:00", "2026-11-18"));
});
