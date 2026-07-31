import { chromium } from 'playwright';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(ROOT, 'data');
const FORUM = 'https://www.airraidsirens.net/forums/viewtopic.php?t=27945';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false
});
const arr = value => value == null ? [] : Array.isArray(value) ? value : [value];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();
const makeId = (...parts) => crypto
  .createHash('sha1')
  .update(parts.join('|'))
  .digest('hex')
  .slice(0, 16);

function normalizeUrl(raw) {
  return clean(raw)
    .replace(/[)\]}>.,;]+$/g, '')
    .replace(/&amp;/g, '&');
}

function mapId(rawUrl) {
  try {
    const url = new URL(normalizeUrl(rawUrl));
    const queryId = url.searchParams.get('mid') || url.searchParams.get('id');
    if (queryId) return queryId;
    const pathMatch = url.pathname.match(/\/maps\/d\/(?:u\/\d+\/)?(?:viewer|edit)\/([^/?#]+)/i)
      || url.pathname.match(/\/file\/d\/([^/?#]+)/i);
    return pathMatch?.[1] || null;
  } catch {
    return null;
  }
}

function isMapUrl(url) {
  return /(?:google\.[a-z.]+\/maps\/d\/|drive\.google\.com\/|earth\.google\.com\/earth\/d\/)/i.test(url);
}

function sourceName(anchorText, context, fallback = 'Siren map') {
  const text = clean(anchorText);
  const body = clean(context);
  const before = body.slice(Math.max(0, body.indexOf(text) - 180), body.indexOf(text));
  const labeled = before.match(/(?:^|[|•\n])\s*([^|•\n:]{2,80})\s*:\s*$/);
  return clean(labeled?.[1] || text || fallback);
}

function collectRawUrls(text) {
  const decoded = clean(text);
  const urls = decoded.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return urls.map(normalizeUrl).filter(isMapUrl);
}

function walkFolders(node, inherited = {}) {
  const output = [];
  for (const folder of arr(node?.Folder)) {
    const meta = {
      ...inherited,
      folder: clean(folder.name?.['#text'] ?? folder.name ?? inherited.folder)
    };
    output.push(...walkFolders(folder, meta));
    for (const placemark of arr(folder.Placemark)) output.push({ placemark, meta });
  }
  for (const placemark of arr(node?.Placemark)) output.push({ placemark, meta: inherited });
  return output;
}

function parseExtended(placemark) {
  const data = {};
  for (const item of arr(placemark?.ExtendedData?.Data)) {
    data[clean(item?.['@_name'])] = clean(item?.value?.['#text'] ?? item?.value);
  }
  for (const item of arr(placemark?.ExtendedData?.SchemaData?.SimpleData)) {
    data[clean(item?.['@_name'])] = clean(item?.['#text']);
  }
  return data;
}

function firstField(fields, names) {
  const entries = Object.entries(fields);
  for (const wanted of names) {
    const match = entries.find(([key]) => key.toLowerCase() === wanted.toLowerCase());
    if (match?.[1]) return match[1];
  }
  return '';
}

function parseKml(xml, source) {
  const root = parser.parse(xml)?.kml;
  const documents = [...arr(root?.Document), ...arr(root?.Folder)];
  const rows = [];

  for (const document of documents) {
    for (const { placemark, meta } of walkFolders(document)) {
      const coordinates = clean(
        placemark?.Point?.coordinates?.['#text'] ?? placemark?.Point?.coordinates
      );
      if (!coordinates) continue;

      const [lng, lat] = coordinates.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const fields = parseExtended(placemark);
      const name = clean(placemark.name?.['#text'] ?? placemark.name) || 'Unidentified siren';
      const description = clean(placemark.description?.['#text'] ?? placemark.description);
      const combined = [name, description, ...Object.values(fields)].join(' ');

      const status = /\b(inactive|removed|demolished|former|decommissioned|destroyed)\b/i.test(combined)
        ? 'inactive'
        : /\b(active|operational|working|in service)\b/i.test(combined)
          ? 'active'
          : 'unknown';

      const schedule =
        (combined.match(/(?:weekly|monthly|quarterly|annual(?:ly)?|every\s+\w+|first\s+\w+|last\s+\w+)[^.;]{0,150}(?:test|noon|am|pm)?/i) || [])[0]
        || (combined.match(/(?:test(?:ed|ing)?|schedule)[^.;]{0,150}/i) || [])[0]
        || '';

      rows.push({
        id: makeId(source.mid, name, lat, lng),
        name,
        lat,
        lng,
        status,
        manufacturer: firstField(fields, ['Manufacturer', 'Make', 'Brand']),
        model: firstField(fields, ['Model', 'Siren Model']) || name,
        city: firstField(fields, ['City', 'Town', 'Municipality']),
        state: firstField(fields, ['State', 'Province', 'Region']) || source.name,
        category: meta.folder || firstField(fields, ['Type', 'Category']) || 'Outdoor warning siren',
        mount: firstField(fields, ['Mount', 'Mounting', 'Installation']),
        testSchedule: clean(schedule),
        description,
        sourceMap: source.name,
        sourceUrl: source.url,
        sourceMid: source.mid
      });
    }
  }
  return rows;
}

async function readViaProxy(url) {
  const target = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
  const response = await fetch(target, {
    headers: { 'user-agent': UA, accept: 'text/plain,text/markdown,*/*' },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`proxy HTTP ${response.status}`);
  return response.text();
}

async function readViaBrowser(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!response || response.status() >= 400) throw new Error(`browser HTTP ${response?.status()}`);
  await page.waitForTimeout(1200);
  return {
    body: await page.locator('body').innerText(),
    anchors: await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => ({
      href: anchor.href,
      text: (anchor.textContent || '').trim(),
      context: (anchor.closest('.postbody')?.innerText || anchor.parentElement?.innerText || '').slice(0, 8000)
    })))
  };
}

function addMap(links, rawUrl, name = '') {
  const url = normalizeUrl(rawUrl);
  const mid = mapId(url);
  if (!mid || !isMapUrl(url)) return;
  const previous = links.get(mid);
  links.set(mid, {
    mid,
    url,
    name: clean(name || previous?.name || `Siren map ${mid.slice(0, 8)}`)
  });
}

await fs.mkdir(OUT, { recursive: true });

const links = new Map();
let browser;
let page;

try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ userAgent: UA, locale: 'en-US' });
} catch (error) {
  console.warn('Chromium unavailable:', error.message);
}

let consecutiveEmpty = 0;
for (let start = 0; start <= 1000 && consecutiveEmpty < 8; start += 10) {
  const url = start ? `${FORUM}&start=${start}` : FORUM;
  const before = links.size;
  let loaded = false;

  if (page) {
    try {
      const result = await readViaBrowser(page, url);
      for (const anchor of result.anchors) {
        if (!isMapUrl(anchor.href)) continue;
        addMap(links, anchor.href, sourceName(anchor.text, anchor.context));
      }
      for (const raw of collectRawUrls(result.body)) addMap(links, raw);
      loaded = true;
    } catch (error) {
      console.warn('browser page failed', start, error.message);
    }
  }

  try {
    const text = await readViaProxy(url);
    for (const raw of collectRawUrls(text)) {
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const label = text.match(new RegExp(`\\[([^\\]]{2,100})\\]\\(${escaped}\\)`))?.[1] || '';
      addMap(links, raw, label);
    }
    loaded = true;
  } catch (error) {
    console.warn('proxy page failed', start, error.message);
  }

  const added = links.size - before;
  console.log(`thread start=${start}: +${added} maps (${links.size} total)`);
  consecutiveEmpty = loaded && added === 0 ? consecutiveEmpty + 1 : 0;
  await sleep(500);
}

if (browser) await browser.close();

const maps = [...links.values()];
const sirens = [];
const manifest = [];

for (const [index, map] of maps.entries()) {
  const exportUrls = [
    `https://www.google.com/maps/d/kml?forcekml=1&mid=${encodeURIComponent(map.mid)}`,
    `https://www.google.com/maps/d/u/0/kml?forcekml=1&mid=${encodeURIComponent(map.mid)}`
  ];

  let success = false;
  let lastError = '';

  for (const kmlUrl of exportUrls) {
    try {
      const response = await fetch(kmlUrl, {
        headers: {
          'user-agent': UA,
          accept: 'application/vnd.google-earth.kml+xml,application/xml,text/xml,*/*'
        },
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!/<kml[\s>]/i.test(text)) throw new Error('response was not KML');

      const rows = parseKml(text, map);
      sirens.push(...rows);
      manifest.push({ ...map, kml: kmlUrl, status: 'ok', pins: rows.length });
      success = true;
      break;
    } catch (error) {
      lastError = error.message;
    }
  }

  if (!success) {
    manifest.push({ ...map, kml: exportUrls[0], status: 'failed', error: lastError, pins: 0 });
  }

  const latest = manifest.at(-1);
  console.log(`${index + 1}/${maps.length}`, map.name, latest.status, latest.pins);
  await sleep(250);
}

const unique = [...new Map(
  sirens.map(siren => [
    `${siren.lat.toFixed(6)},${siren.lng.toFixed(6)},${siren.name.toLowerCase()}`,
    siren
  ])
).values()];

unique.sort((a, b) =>
  String(a.state).localeCompare(String(b.state))
  || String(a.name).localeCompare(String(b.name))
);

await fs.writeFile(path.join(OUT, 'sirens.json'), JSON.stringify(unique, null, 2));
await fs.writeFile(
  path.join(OUT, 'sirens.js'),
  `window.IDENTI_SIRENS=${JSON.stringify(unique)};\nwindow.IDENTI_MAP_MANIFEST=${JSON.stringify(manifest)};\n`
);
await fs.writeFile(path.join(OUT, 'map-manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`Finished: ${maps.length} maps, ${unique.length} unique pins`);
if (!maps.length || !unique.length) process.exitCode = 2;
