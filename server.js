const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const { performance } = require("perf_hooks");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const FETCH_LIMIT = 4 * 1024 * 1024;
const SPORTTERY_LIST_URL =
  "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c";
const SPORTTERY_SUPPORT_URL =
  "https://webapi.sporttery.cn/gateway/jc/common/getSupportRateV1.qry";
const SPORTTERY_HISTORY_URL =
  "https://webapi.sporttery.cn/gateway/uniform/football/getOddsHistoryV1.qry";
const SPORTTERY_REFERER = "https://m.sporttery.cn/mjc/jsq/zqhhgg/";
const API_CACHE_MS = 60 * 1000;
const DETAIL_CACHE_MS = 3 * 60 * 1000;
const LATENCY_TIMEOUT_MS = 8000;
const LATENCY_MAX_SAMPLES = 3;
const ALLOWED_HOSTS = [
  "sporttery.cn",
  "www.sporttery.cn",
  "m.sporttery.cn",
  "500.com",
  "www.500.com",
  "odds.500.com",
  "trade.500.com",
  "52aitou.com",
  "www.52aitou.com",
  "m9084.52aitou.com",
  "59itou.com",
  "www.59itou.com",
  "kt.59itou.com"
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const apiCache = new Map();

function isAllowedHost(hostname) {
  return (
    ALLOWED_HOSTS.includes(hostname) ||
    hostname.endsWith(".sporttery.cn") ||
    hostname.endsWith(".500.com") ||
    hostname.endsWith(".52aitou.com") ||
    hostname.endsWith(".59itou.com")
  );
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPrivateIp(normalized.replace("::ffff:", ""));
    }

    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

async function assertPublicHttpTarget(target) {
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Only http and https URLs can be measured.");
  }

  const hostname = target.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local and private hosts are not allowed for latency checks.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Private IP addresses are not allowed for latency checks.");
    }
    return;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error("The hostname resolves to a private or unavailable address.");
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function cacheGet(key) {
  const entry = apiCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    apiCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  apiCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
  return value;
}

function officialHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 OddsWorkbench/0.2",
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    referer: SPORTTERY_REFERER,
    origin: "https://m.sporttery.cn",
    "x-requested-with": "XMLHttpRequest"
  };
}

async function fetchText(targetUrl, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const remoteRes = await fetch(targetUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers
    });

    const buffer = Buffer.from(await remoteRes.arrayBuffer());
    if (buffer.length > FETCH_LIMIT) {
      throw new Error("Remote response is larger than the 4 MB safety limit.");
    }

    return {
      ok: remoteRes.ok,
      statusCode: remoteRes.status,
      contentType: remoteRes.headers.get("content-type") || "",
      finalUrl: remoteRes.url,
      text: buffer.toString("utf8")
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRemote(targetUrl) {
  const parsed = new URL(targetUrl);
  return fetchText(parsed, {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 OddsWorkbench/0.1",
    accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    referer: `${parsed.protocol}//${parsed.hostname}/`
  });
}

async function measureLatencyOnce(target) {
  await assertPublicHttpTarget(target);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LATENCY_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch(target.href, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 OpenPrepLatency/0.1",
        accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        "cache-control": "no-cache"
      }
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (response.body) {
      response.body.cancel().catch(() => {});
    }

    return {
      ok: response.ok || (response.status >= 300 && response.status < 400),
      statusCode: response.status,
      elapsedMs,
      contentType: response.headers.get("content-type") || "",
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error.name === "AbortError" ? "timeout" : error.message || "request failed",
      checkedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeLatency(samples) {
  const sorted = samples
    .filter((sample) => sample.ok && Number.isFinite(sample.elapsedMs))
    .map((sample) => sample.elapsedMs)
    .sort((a, b) => a - b);
  const failures = samples.length - sorted.length;
  const avg = sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : null;
  const p95Index = sorted.length ? Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1) : -1;

  return {
    averageMs: avg,
    p95Ms: p95Index >= 0 ? sorted[p95Index] : null,
    minMs: sorted[0] || null,
    maxMs: sorted[sorted.length - 1] || null,
    failureRate: samples.length ? Math.round((failures / samples.length) * 100) : 0
  };
}

async function measureLatency(target, sampleCount) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await measureLatencyOnce(target));
  }

  return {
    url: target.href,
    host: target.hostname,
    sampleCount,
    ...summarizeLatency(samples),
    samples
  };
}

async function fetchOfficialJson(url) {
  const response = await fetchText(url, officialHeaders());
  const json = parseJson(response.text);
  if (!response.ok || !json) {
    throw new Error(`Official endpoint failed: ${url}`);
  }
  if (String(json.errorCode) !== "0") {
    throw new Error(json.errorMessage || "Official endpoint returned an error.");
  }
  return json;
}

function normalizeMatches(raw) {
  return (raw?.value?.matchInfoList || []).flatMap((group) =>
    (group.subMatchList || []).map((match) => ({
      matchId: match.matchId,
      businessDate: match.businessDate,
      matchDate: match.matchDate,
      matchTime: String(match.matchTime || "").slice(0, 5),
      matchDateTime: `${match.matchDate} ${String(match.matchTime || "").slice(0, 5)}`.trim(),
      serial: match.matchNumStr,
      serialNumber: match.matchNum,
      serialDate: match.matchNumDate,
      taxDateNo: match.taxDateNo,
      leagueId: match.leagueId,
      league: match.leagueAbbName,
      leagueFull: match.leagueAllName,
      home: match.homeTeamAllName,
      homeShort: match.homeTeamAbbName,
      homeRank: match.homeRank,
      away: match.awayTeamAllName,
      awayShort: match.awayTeamAbbName,
      awayRank: match.awayRank,
      status: match.matchStatus,
      remark: match.remark || "",
      sellStatus: match.sellStatus,
      pools: (match.poolList || []).map((pool) => ({
        code: pool.poolCode,
        status: pool.poolStatus,
        single: Number(pool.single) === 1
      })),
      current: {
        had: match.had || null,
        hhad: match.hhad || null,
        ttg: match.ttg || null,
        hafu: match.hafu || null,
        crs: match.crs || null
      }
    }))
  );
}

function summarizeOdds(match) {
  const current = match.current || {};
  const had = current.had || {};
  const hhad = current.hhad || {};
  return {
    had: had.h ? { win: had.h, draw: had.d, lose: had.a } : null,
    hhad: hhad.h
      ? {
          line: hhad.goalLine,
          win: hhad.h,
          draw: hhad.d,
          lose: hhad.a
        }
      : null,
    ttg: current.ttg
      ? {
          s0: current.ttg.s0,
          s1: current.ttg.s1,
          s2: current.ttg.s2,
          s3: current.ttg.s3,
          s4: current.ttg.s4,
          s5: current.ttg.s5,
          s6: current.ttg.s6,
          s7: current.ttg.s7
        }
      : null
  };
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function impliedProbabilities(odds) {
  const entries = [
    ["home", toNumber(odds?.h)],
    ["draw", toNumber(odds?.d)],
    ["away", toNumber(odds?.a)]
  ].filter(([, value]) => value && value > 0);

  if (entries.length !== 3) return null;
  const rawTotal = entries.reduce((sum, [, value]) => sum + 1 / value, 0);
  return Object.fromEntries(entries.map(([key, value]) => [key, round((1 / value / rawTotal) * 100, 2)]));
}

function extractSupportSummary(supportEntry, type) {
  if (!supportEntry) return null;
  return {
    type,
    homeSupportRate: supportEntry.hSupportRate || null,
    drawSupportRate: supportEntry.dSupportRate || null,
    awaySupportRate: supportEntry.aSupportRate || null,
    homeProbability: supportEntry.hProbability || null,
    drawProbability: supportEntry.dProbability || null,
    awayProbability: supportEntry.aProbability || null
  };
}

function parsePercentString(value) {
  if (!value) return null;
  const numeric = Number(String(value).replace("%", ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function buildPrediction(match, supportEntry) {
  const hadProbs = impliedProbabilities(match.current?.had);
  const hhadProbs = impliedProbabilities(match.current?.hhad);
  const source = hadProbs || hhadProbs;
  if (!source) {
    return {
      result: "数据不足",
      confidence: "低",
      score: null,
      reasons: ["当前没有可用的三项赔率结构，暂不生成倾向。"] 
    };
  }

  const supportHome = parsePercentString(supportEntry?.HAD?.hSupportRate || supportEntry?.HHAD?.hSupportRate);
  const supportDraw = parsePercentString(supportEntry?.HAD?.dSupportRate || supportEntry?.HHAD?.dSupportRate);
  const supportAway = parsePercentString(supportEntry?.HAD?.aSupportRate || supportEntry?.HHAD?.aSupportRate);
  const supportMap = {
    home: supportHome,
    draw: supportDraw,
    away: supportAway
  };

  const scoring = Object.entries(source).map(([key, value]) => {
    const support = supportMap[key];
    const supportAdj = Number.isFinite(support) ? (support - 33.33) * 0.08 : 0;
    return [key, value + supportAdj];
  });
  scoring.sort((a, b) => b[1] - a[1]);

  const [bestKey, bestScore] = scoring[0];
  const secondScore = scoring[1]?.[1] ?? 0;
  const margin = bestScore - secondScore;
  const confidence = margin >= 10 ? "高" : margin >= 5 ? "中" : "低";
  const labels = { home: "主胜倾向", draw: "平局倾向", away: "客胜倾向" };
  const reasons = [];

  reasons.push(`赔率换算后的领先项为${labels[bestKey].replace("倾向", "")}，优势差约 ${round(margin, 2)} 分。`);

  const supportValue = supportMap[bestKey];
  if (Number.isFinite(supportValue)) {
    reasons.push(`同方向支持率约 ${round(supportValue, 1)}%，作为公众热度参考。`);
  }

  if (match.current?.hhad?.goalLine) {
    reasons.push(`让球胜平负当前让球为 ${match.current.hhad.goalLine}。`);
  }

  return {
    result: labels[bestKey],
    confidence,
    score: round(bestScore, 2),
    reasons
  };
}

function buildPatternTags(match, supportEntry) {
  const tags = [];
  const had = match.current?.had;
  const hh = match.current?.hhad;
  const home = toNumber(had?.h);
  const away = toNumber(had?.a);

  if (home && away) {
    if (home < away) tags.push("主队赔率更低");
    if (away < home) tags.push("客队赔率更低");
    if (Math.abs(home - away) < 0.2) tags.push("胜负赔率接近");
  }

  if (hh?.goalLine) {
    tags.push(`让球 ${hh.goalLine}`);
  }

  const support = supportEntry?.HAD || supportEntry?.HHAD;
  const hSupport = parsePercentString(support?.hSupportRate);
  const aSupport = parsePercentString(support?.aSupportRate);
  if (Number.isFinite(hSupport) && hSupport >= 55) tags.push("主向热度偏高");
  if (Number.isFinite(aSupport) && aSupport >= 55) tags.push("客向热度偏高");

  return tags;
}

function summarizeMatch(match, supportMap) {
  const supportEntry = supportMap[`_${match.matchId}`] || null;
  return {
    ...match,
    oddsSummary: summarizeOdds(match),
    support: {
      had: extractSupportSummary(supportEntry?.HAD, "HAD"),
      hhad: extractSupportSummary(supportEntry?.HHAD, "HHAD")
    },
    tags: buildPatternTags(match, supportEntry),
    prediction: buildPrediction(match, supportEntry)
  };
}

async function getDashboardData() {
  const cached = cacheGet("sporttery:dashboard");
  if (cached) return cached;

  const listJson = await fetchOfficialJson(SPORTTERY_LIST_URL);
  const matches = normalizeMatches(listJson);
  const ids = matches.map((match) => match.matchId).join(",");
  const supportUrl = new URL(SPORTTERY_SUPPORT_URL);
  supportUrl.searchParams.set("matchIds", ids);
  supportUrl.searchParams.set("poolCode", "hhad,had");
  supportUrl.searchParams.set("sportType", "1");
  const supportJson = await fetchOfficialJson(supportUrl);
  const supportMap = supportJson?.value || {};

  const data = {
    fetchedAt: new Date().toISOString(),
    source: "中国体育彩票官方接口",
    totalCount: matches.length,
    leagues: [...new Set(matches.map((match) => match.league).filter(Boolean))],
    lastUpdateTime: listJson?.value?.lastUpdateTime || "",
    matches: matches.map((match) => summarizeMatch(match, supportMap))
  };

  return cacheSet("sporttery:dashboard", data, API_CACHE_MS);
}

function compactHistoryEntry(poolCode, entry) {
  if (!entry) return null;
  switch (poolCode) {
    case "had":
    case "hhad":
      return {
        updateDate: entry.updateDate,
        updateTime: entry.updateTime,
        line: entry.goalLine || "",
        home: entry.h,
        draw: entry.d,
        away: entry.a,
        flags: {
          home: entry.hf,
          draw: entry.df,
          away: entry.af
        }
      };
    case "ttg":
      return {
        updateDate: entry.updateDate,
        updateTime: entry.updateTime,
        goals: {
          s0: entry.s0,
          s1: entry.s1,
          s2: entry.s2,
          s3: entry.s3,
          s4: entry.s4,
          s5: entry.s5,
          s6: entry.s6,
          s7: entry.s7
        }
      };
    case "hafu":
      return {
        updateDate: entry.updateDate,
        updateTime: entry.updateTime,
        matrix: {
          hh: entry.hh,
          hd: entry.hd,
          ha: entry.ha,
          dh: entry.dh,
          dd: entry.dd,
          da: entry.da,
          ah: entry.ah,
          ad: entry.ad,
          aa: entry.aa
        }
      };
    case "crs":
      return {
        updateDate: entry.updateDate,
        updateTime: entry.updateTime,
        scoreline: entry
      };
    default:
      return entry;
  }
}

function summarizeHistory(poolCode, list) {
  const latest = list[0] || null;
  const earliest = list[list.length - 1] || null;
  if (!latest || !earliest) return null;

  if (poolCode === "had" || poolCode === "hhad") {
    return {
      points: list.length,
      latest: compactHistoryEntry(poolCode, latest),
      earliest: compactHistoryEntry(poolCode, earliest),
      delta: {
        home: round(toNumber(latest.h) - toNumber(earliest.h), 2),
        draw: round(toNumber(latest.d) - toNumber(earliest.d), 2),
        away: round(toNumber(latest.a) - toNumber(earliest.a), 2)
      }
    };
  }

  if (poolCode === "ttg") {
    return {
      points: list.length,
      latest: compactHistoryEntry(poolCode, latest),
      earliest: compactHistoryEntry(poolCode, earliest),
      delta: {
        s0: round(toNumber(latest.s0) - toNumber(earliest.s0), 2),
        s1: round(toNumber(latest.s1) - toNumber(earliest.s1), 2),
        s2: round(toNumber(latest.s2) - toNumber(earliest.s2), 2),
        s3: round(toNumber(latest.s3) - toNumber(earliest.s3), 2),
        s4: round(toNumber(latest.s4) - toNumber(earliest.s4), 2),
        s5: round(toNumber(latest.s5) - toNumber(earliest.s5), 2),
        s6: round(toNumber(latest.s6) - toNumber(earliest.s6), 2),
        s7: round(toNumber(latest.s7) - toNumber(earliest.s7), 2)
      }
    };
  }

  if (poolCode === "hafu") {
    return {
      points: list.length,
      latest: compactHistoryEntry(poolCode, latest),
      earliest: compactHistoryEntry(poolCode, earliest),
      delta: {
        hh: round(toNumber(latest.hh) - toNumber(earliest.hh), 2),
        hd: round(toNumber(latest.hd) - toNumber(earliest.hd), 2),
        ha: round(toNumber(latest.ha) - toNumber(earliest.ha), 2),
        dh: round(toNumber(latest.dh) - toNumber(earliest.dh), 2),
        dd: round(toNumber(latest.dd) - toNumber(earliest.dd), 2),
        da: round(toNumber(latest.da) - toNumber(earliest.da), 2),
        ah: round(toNumber(latest.ah) - toNumber(earliest.ah), 2),
        ad: round(toNumber(latest.ad) - toNumber(earliest.ad), 2),
        aa: round(toNumber(latest.aa) - toNumber(earliest.aa), 2)
      }
    };
  }

  return {
    points: list.length,
    latest: compactHistoryEntry(poolCode, latest),
    earliest: compactHistoryEntry(poolCode, earliest)
  };
}

async function getMatchDetail(matchId) {
  const cacheKey = `sporttery:detail:${matchId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const dashboard = await getDashboardData();
  const match = dashboard.matches.find((item) => String(item.matchId) === String(matchId));
  if (!match) {
    throw new Error("Match not found.");
  }

  const poolCodes = match.pools.map((pool) => pool.code.toLowerCase());
  const historyEntries = await Promise.all(
    poolCodes.map(async (poolCode) => {
      const historyUrl = new URL(SPORTTERY_HISTORY_URL);
      historyUrl.searchParams.set("matchId", matchId);
      historyUrl.searchParams.set("poolCode", poolCode);
      const historyJson = await fetchOfficialJson(historyUrl);
      const value = historyJson.value || {};
      const listKey = `${poolCode}List`;
      const rows = Array.isArray(value[listKey]) ? value[listKey] : [];
      return {
        poolCode: poolCode.toUpperCase(),
        points: rows.map((item) => compactHistoryEntry(poolCode, item)),
        summary: summarizeHistory(poolCode, rows)
      };
    })
  );

  const detail = {
    fetchedAt: new Date().toISOString(),
    match,
    history: Object.fromEntries(historyEntries.map((entry) => [entry.poolCode, entry]))
  };

  return cacheSet(cacheKey, detail, DETAIL_CACHE_MS);
}

async function handleFetch(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const rawTarget = requestUrl.searchParams.get("url");

  if (!rawTarget) {
    sendJson(res, 400, { error: "Missing url query parameter." });
    return;
  }

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    sendJson(res, 400, { error: "Invalid URL." });
    return;
  }

  if (!["http:", "https:"].includes(target.protocol) || !isAllowedHost(target.hostname)) {
    sendJson(res, 403, {
      error: "This local proxy only allows sporttery.cn, 500.com, 52aitou.com, and 59itou.com domains.",
      host: target.hostname
    });
    return;
  }

  try {
    const payload = await fetchRemote(target.href);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 502, {
      error: error.message || String(error) || "Failed to fetch remote content.",
      hint: "Some lottery pages are dynamic, anti-scraping protected, or require browser/WeChat authorization."
    });
  }
}

async function handleLatency(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const rawTarget = requestUrl.searchParams.get("url");
  const sampleCount = Math.max(
    1,
    Math.min(LATENCY_MAX_SAMPLES, Number(requestUrl.searchParams.get("samples")) || LATENCY_MAX_SAMPLES)
  );

  if (!rawTarget) {
    sendJson(res, 400, { error: "Missing url query parameter." });
    return;
  }

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    sendJson(res, 400, { error: "Invalid URL." });
    return;
  }

  try {
    const payload = await measureLatency(target, sampleCount);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 400, {
      error: error.message || "Latency check failed.",
      hint: "Use a public official http/https entry URL. Local, intranet, and private IP targets are blocked."
    });
  }
}

async function handleSportteryDashboard(res) {
  try {
    const payload = await getDashboardData();
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 502, {
      error: error.message || "Failed to load official Sporttery dashboard data."
    });
  }
}

async function handleSportteryDetail(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const matchId = requestUrl.searchParams.get("matchId");

  if (!matchId) {
    sendJson(res, 400, { error: "Missing matchId query parameter." });
    return;
  }

  try {
    const payload = await getMatchDetail(matchId);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, error.message === "Match not found." ? 404 : 502, {
      error: error.message || "Failed to load official match detail."
    });
  }
}

function safeFilePath(requestPath) {
  const pathname = decodeURIComponent(new URL(requestPath, "http://local").pathname);
  const requested = pathname === "/" ? "/ticket-assistant.html" : pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function serveStatic(req, res) {
  const filePath = safeFilePath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500, {
        "content-type": "text/plain; charset=utf-8"
      });
      res.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/latency")) {
    handleLatency(req, res);
    return;
  }

  if (req.url.startsWith("/api/fetch")) {
    handleFetch(req, res);
    return;
  }

  if (req.url.startsWith("/api/sporttery/dashboard")) {
    handleSportteryDashboard(res);
    return;
  }

  if (req.url.startsWith("/api/sporttery/detail")) {
    handleSportteryDetail(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Football odds workbench running at http://localhost:${PORT}`);
});
