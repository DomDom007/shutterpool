// Shutterpool: a QR poster that sends guests to one shared album, then a sorter that groups, de-duplicates and picks the best shots.
import { useState } from "react";
import { zipSync } from "fflate";
import { useStored } from "./lib/store";
import { Section, Stat, Stats } from "./ui/kit";
import { QR } from "./ui/QR";

const T = "shutterpool";
type Photo = { id: string; file: File; url: string; time: number; hash: string; sharp: number; group: number; dupOf?: string };

/** Read the original capture time from JPEG EXIF (DateTimeOriginal), falling back to the file date. */
async function exifTime(f: File): Promise<number> {
  try {
    const b = new DataView(await f.slice(0, 128 * 1024).arrayBuffer());
    if (b.getUint16(0) !== 0xffd8) return f.lastModified;
    let o = 2;
    while (o < b.byteLength - 4) {
      const marker = b.getUint16(o), len = b.getUint16(o + 2);
      if (marker === 0xffe1 && b.getUint32(o + 4) === 0x45786966) {
        const text = new TextDecoder("ascii").decode(new Uint8Array(b.buffer, o + 10, Math.min(len, b.byteLength - o - 10)));
        const m = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      }
      o += 2 + len;
    }
  } catch { /* unreadable EXIF */ }
  return f.lastModified;
}
/** Difference hash (64 bits) for near-duplicate detection, plus a sharpness score (variance of the Laplacian). */
async function analyse(file: File): Promise<{ hash: string; sharp: number }> {
  const img = await createImageBitmap(file);
  const c = document.createElement("canvas"), x = c.getContext("2d", { willReadFrequently: true })!;
  c.width = 9; c.height = 8; x.drawImage(img, 0, 0, 9, 8);
  const d = x.getImageData(0, 0, 9, 8).data, g = (i: number) => d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
  let hash = ""; for (let r = 0; r < 8; r++) for (let k = 0; k < 8; k++) hash += g(r * 9 + k) > g(r * 9 + k + 1) ? "1" : "0";
  const S = 160; c.width = S; c.height = Math.round((S * img.height) / img.width); x.drawImage(img, 0, 0, c.width, c.height);
  const p = x.getImageData(0, 0, c.width, c.height).data, w = c.width, L: number[] = [];
  for (let yy = 1; yy < c.height - 1; yy++) for (let xx = 1; xx < w - 1; xx++) { const i = yy * w + xx, v = (j: number) => p[j * 4] * 0.3 + p[j * 4 + 1] * 0.59 + p[j * 4 + 2] * 0.11; L.push(4 * v(i) - v(i - 1) - v(i + 1) - v(i - w) - v(i + w)); }
  const m = L.reduce((a, b) => a + b, 0) / L.length;
  return { hash, sharp: L.reduce((a, b) => a + (b - m) ** 2, 0) / L.length };
}
const ham = (a: string, b: string) => [...a].filter((c, i) => c !== b[i]).length;

export default function Shutterpool() {
  const [ev, setEv] = useStored(T, "event", { name: "Amira and Karim's wedding", date: "2026-10-17", album: "https://photos.app.goo.gl/your-shared-album", note: "Add every photo you take tonight. Blurry ones too, we'll sort them!" });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [prog, setProg] = useState<number | null>(null);
  const [fav, setFav] = useState<string[]>([]);
  const [hideDups, setHideDups] = useState(true);
  const [gapMin, setGapMin] = useState(20);

  const load = async (list: FileList | null) => {
    if (!list) return;
    const files = [...list].filter(f => f.type.startsWith("image/")).slice(0, 600);
    const out: Photo[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i], url = URL.createObjectURL(f);
      try { const [time, a] = await Promise.all([exifTime(f), analyse(f)]); out.push({ id: f.name + i, file: f, url, time, ...a, group: 0 }); } catch { /* skip files the browser can't decode */ }
      setProg((i + 1) / files.length);
    }
    out.sort((a, b) => a.time - b.time);
    // Near-duplicates: taken within 2 minutes and hashes differing by at most 10 bits. Keep the sharpest.
    out.forEach((p, i) => { for (let j = i - 1; j >= 0 && p.time - out[j].time < 120000; j--) { const q = out[j]; const keep = q.dupOf ? out.find(x => x.id === q.dupOf)! : q; if (ham(p.hash, q.hash) <= 10) { if (p.sharp > keep.sharp) { keep.dupOf = p.id; out.forEach(x => { if (x.dupOf === keep.id) x.dupOf = p.id; }); } else p.dupOf = keep.id; break; } } });
    setPhotos(out); setProg(null);
  };
  // Group into moments live, so changing the gap regroups instantly.
  let gi = 0;
  const groupOf = new Map(photos.map((p, i) => [p.id, i && p.time - photos[i - 1].time > gapMin * 60000 ? ++gi : gi]));
  const groups = [...new Set(groupOf.values())];
  const kept = photos.filter(p => !p.dupOf);
  const zip = async () => {
    const pick = photos.filter(p => fav.includes(p.id));
    const files: Record<string, Uint8Array> = {};
    for (const p of pick) files[`${String(pick.indexOf(p) + 1).padStart(3, "0")}-${p.file.name}`] = new Uint8Array(await p.file.arrayBuffer());
    const blob = new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: "application/zip" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${ev.name} favourites.zip`; a.click();
  };

  return (
    <div className="stack">
      <div className="grid2">
        <Section title="Before the event">
          <div className="stack" style={{ gap: 10 }}>
            <label className="field"><span>Event</span><input className="input" value={ev.name} onChange={e => setEv({ ...ev, name: e.target.value })} /></label>
            <label className="field"><span>Shared album or upload link (Google Photos shared album, Google Drive folder or Dropbox file request, all free)</span><input className="input" value={ev.album} onChange={e => setEv({ ...ev, album: e.target.value })} /></label>
            <label className="field"><span>Message on the poster</span><input className="input" value={ev.note} onChange={e => setEv({ ...ev, note: e.target.value })} /></label>
            <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={() => window.print()}>Print table cards</button>
          </div>
        </Section>
        <div className="sp-card"><p className="sp-e">Share your photos</p><h3>{ev.name}</h3><div className="sp-qr"><QR text={ev.album} size={200} /></div><p>{ev.note}</p><p className="sp-small">Scan with your phone camera</p></div>
      </div>
      <Section title="After the event: sort the photos" aside={<label className="btn small primary">Choose photos<input type="file" accept="image/*" multiple hidden onChange={e => load(e.target.files)} /></label>}>
        <p className="note" style={{ marginBottom: 10 }}>Download everything from the album, then choose the photos here (up to 600 at a time). Nothing is uploaded; the sorting happens on this device.</p>
        {prog !== null && <p className="pill warn">Reading photos… {Math.round(prog * 100)}%</p>}
        {photos.length > 0 && <>
          <Stats><Stat value={photos.length} label="Photos" /><Stat value={photos.length - kept.length} label="Near-duplicates" tone="warn" /><Stat value={groups.length} label="Moments" /><Stat value={fav.length} label="Favourites" tone="good" /></Stats>
          <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
            <label className="check"><input type="checkbox" checked={hideDups} onChange={e => setHideDups(e.target.checked)} />Hide duplicates (keep the sharpest)</label>
            <label className="field" style={{ flex: "0 0 200px" }}><span>New moment after a gap of</span><select className="input" value={gapMin} onChange={e => setGapMin(+e.target.value)}>{[5, 10, 20, 45, 90].map(n => <option key={n} value={n}>{n} minutes</option>)}</select></label>
            <button className="btn small" onClick={() => setFav(kept.filter(p => p.sharp > 60).map(p => p.id))}>Star every sharp photo</button>
            <button className="btn small primary" disabled={!fav.length} onClick={zip}>Download {fav.length} favourites as ZIP</button>
          </div>
        </>}
      </Section>
      {groups.map(g => { const list = photos.filter(p => groupOf.get(p.id) === g && (!hideDups || !p.dupOf)); if (!list.length) return null; const t = new Date(list[0].time); return (
        <Section key={g} title={`Moment ${g + 1}`} aside={<span className="note">{t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · {list.length} photos</span>}>
          <div className="sp-grid">{list.map(p => <button key={p.id} className={"sp-ph" + (fav.includes(p.id) ? " fav" : "") + (p.sharp < 25 ? " blur" : "")} onClick={() => setFav(fav.includes(p.id) ? fav.filter(x => x !== p.id) : [...fav, p.id])} title={p.file.name}><img src={p.url} alt="" loading="lazy" />{p.sharp < 25 && <em>Blurry</em>}{fav.includes(p.id) && <b>Favourite</b>}</button>)}</div>
        </Section>); })}
      <style>{`.sp-card{background:#fff;color:#151933;border-radius:16px;padding:28px;text-align:center;box-shadow:var(--shadow);display:grid;gap:8px;justify-items:center}.sp-card h3{font-size:30px}.sp-e{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#555C78}.sp-qr{background:#fff;padding:8px}.sp-small{font-size:12px;color:#555C78}
      .sp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px}.sp-ph{position:relative;padding:0;border:3px solid transparent;border-radius:8px;overflow:hidden;cursor:pointer;background:var(--sunk);aspect-ratio:1}.sp-ph img{width:100%;height:100%;object-fit:cover;display:block}.sp-ph.fav{border-color:var(--good)}.sp-ph.blur img{opacity:.5}
      .sp-ph em,.sp-ph b{position:absolute;left:4px;bottom:4px;font-style:normal;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff}.sp-ph b{background:var(--good)}
      @media print{body *{visibility:hidden}.sp-card,.sp-card *{visibility:visible}.sp-card{position:absolute;inset:0 auto auto 0;width:100%;box-shadow:none}}`}</style>
    </div>
  );
}
