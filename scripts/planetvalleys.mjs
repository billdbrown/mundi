/**
 * The planet's carved valleys for the hex view, in scripts. Inside the planet page the hex view
 * gets them by message (main.ts sendValleys); a standalone hex.html never sees the planet, so
 * scripts load it once, take its valleys, and hand them to each hex page.
 */
/** Load the planet for a seed in a page of its own, wait for its valleys, return them. */
export async function planetValleys(browser, base, seed = '1') {
  const p = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await p.goto(`${base}#seed=${seed}`);
  await p.waitForFunction(() => window.mundi?.world, null, { timeout: 180000 });
  await p.waitForFunction(() => window.mundi.view.valleyCarve(), null, { timeout: 180000 });
  const v = await p.evaluate(() => {
    const v = window.mundi.view.valleyCarve(), b = new Uint8Array(v.half.buffer);
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { n: v.n, b64: btoa(s), hash: location.hash.slice(1) };
  });
  await p.close();
  return v;
}
/** Give them to a hex page with a hex on show, and wait for it to be built again with them. */
export async function giveValleys(page, v) {
  await page.evaluate((v) => {
    const s = atob(v.b64), b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    window.hex.takeValleys(v.hash, v.n, new Uint16Array(b.buffer));
  }, v);
  await page.waitForFunction(() => window.hex.valleys && !window.hex.busy, null, { timeout: 120000 });
}
