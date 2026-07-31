import { chromium } from 'playwright';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = path.join(ROOT, 'data');
const FORUM = 'https://www.airraidsirens.net/forums/viewtopic.php?t=27945';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:'@_', textNodeName:'#text', trimValues:true, parseTagValue:false });
const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => String(v ?? '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const id = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0,16);

function mapId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('mid') || u.searchParams.get('id');
  } catch { return null; }
}
function guessSourceName(anchorText, context) {
  const idx = context.indexOf(anchorText);
  const before = context.slice(Math.max(0, idx - 120), idx);
  const m = before.match(/(?:^|\n|>)([^\n:]{2,55}):\s*$/);
  return clean(m?.[1] || anchorText || 'Siren map');
}
function walkFolders(node, inherited={}) {
  const out=[];
  for (const f of arr(node?.Folder)) {
    const meta={...inherited, folder:clean(f.name?.['#text'] ?? f.name ?? inherited.folder)};
    out.push(...walkFolders(f,meta));
    for (const p of arr(f.Placemark)) out.push({p,meta});
  }
  for (const p of arr(node?.Placemark)) out.push({p,meta:inherited});
  return out;
}
function parseExtended(p) {
  const d={};
  for (const x of arr(p?.ExtendedData?.Data)) d[clean(x?.['@_name'])]=clean(x?.value?.['#text'] ?? x?.value);
  for (const x of arr(p?.ExtendedData?.SchemaData?.SimpleData)) d[clean(x?.['@_name'])]=clean(x?.['#text']);
  return d;
}
function parseKml(xml, source) {
  const root=parser.parse(xml)?.kml;
  const docs=[...arr(root?.Document), ...arr(root?.Folder)];
  const rows=[];
  for (const doc of docs) for (const {p,meta} of walkFolders(doc)) {
    const c=clean(p?.Point?.coordinates?.['#text'] ?? p?.Point?.coordinates);
    if (!c) continue;
    const [lng,lat]=c.split(',').map(Number);
    if (!Number.isFinite(lat)||!Number.isFinite(lng)) continue;
    const ext=parseExtended(p);
    const name=clean(p.name?.['#text'] ?? p.name) || 'Unidentified siren';
    const description=clean(p.description?.['#text'] ?? p.description);
    const combined=[name,description,...Object.values(ext)].join(' ');
    const status=/\b(inactive|removed|demolished|former|decommissioned)\b/i.test(combined)?'inactive':/\b(active|operational|working)\b/i.test(combined)?'active':'unknown';
    const schedule=(combined.match(/(?:test(?:ed|ing)?|schedule)[^.;]{0,130}/i)||[])[0]||'';
    rows.push({
      id:id(source.mid,name,lat,lng), name, lat, lng, status,
      manufacturer:ext.Manufacturer||ext.manufacturer||'',
      model:ext.Model||ext.model||name,
      city:ext.City||ext.city||'',
      state:ext.State||ext.state||source.name,
      category:meta.folder||ext.Type||'Outdoor warning siren',
      mount:ext.Mount||ext.mount||'',
      testSchedule:schedule,
      description,
      sourceMap:source.name,
      sourceUrl:source.url,
      sourceMid:source.mid
    });
  }
  return rows;
}

await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({userAgent:UA,locale:'en-US'});
const links=new Map();
for (let start=0; start<210; start+=10) {
  const url=start?`${FORUM}&start=${start}`:FORUM;
  let ok=false;
  for (let attempt=1;attempt<=3&&!ok;attempt++) {
    try {
      const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      if (!r || r.status()>=400) throw new Error(`HTTP ${r?.status()}`);
      await page.waitForTimeout(1400);
      const found=await page.locator('a[href]').evaluateAll(as=>as.map(a=>({href:a.href,text:(a.textContent||'').trim(),context:(a.closest('.postbody')?.innerText||a.parentElement?.innerText||'').slice(0,5000)})));
      for (const a of found) {
        if (!/google\.(?:com|co\.[a-z]+)\/(?:maps\/d|drive)|drive\.google\.com|earth\.google\.com\/earth\/d/i.test(a.href)) continue;
        const mid=mapId(a.href); if(!mid) continue;
        links.set(mid,{mid,url:a.href,name:guessSourceName(a.text,a.context)});
      }
      ok=true;
    } catch(e) {
      console.warn('forum retry',start,attempt,e.message);
      await sleep(2500*attempt);
    }
  }
}
await browser.close();

const maps=[...links.values()];
const sirens=[];
const manifest=[];
for (const [i,m] of maps.entries()) {
  const kml=`https://www.google.com/maps/d/kml?forcekml=1&mid=${encodeURIComponent(m.mid)}`;
  try {
    const r=await fetch(kml,{headers:{'user-agent':UA,'accept':'application/vnd.google-earth.kml+xml,application/xml,text/xml,*/*'}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const text=await r.text();
    if(!text.includes('<kml')) throw new Error('not KML');
    const rows=parseKml(text,m);
    sirens.push(...rows);
    manifest.push({...m,kml,status:'ok',pins:rows.length});
  } catch(e) {
    manifest.push({...m,kml,status:'failed',error:e.message,pins:0});
  }
  console.log(`${i+1}/${maps.length}`,m.name,manifest.at(-1).status,manifest.at(-1).pins);
  await sleep(350);
}
const unique=[...new Map(sirens.map(s=>[`${s.lat.toFixed(6)},${s.lng.toFixed(6)},${s.name.toLowerCase()}`,s])).values()];
unique.sort((a,b)=>a.state.localeCompare(b.state)||a.name.localeCompare(b.name));
await fs.writeFile(path.join(OUT,'sirens.json'),JSON.stringify(unique,null,2));
await fs.writeFile(path.join(OUT,'sirens.js'),`window.IDENTI_SIRENS=${JSON.stringify(unique)};\nwindow.IDENTI_MAP_MANIFEST=${JSON.stringify(manifest)};\n`);
await fs.writeFile(path.join(OUT,'map-manifest.json'),JSON.stringify(manifest,null,2));
console.log(`Finished: ${maps.length} maps, ${unique.length} unique pins`);
if(!maps.length) process.exitCode=2;
