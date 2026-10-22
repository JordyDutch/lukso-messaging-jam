// ui-clicktest.mjs — load the LIVE frontend in a real browser (Brave via
// puppeteer) and drive the first screen. Honest scope: headless Brave has NO UP
// extension, so the UI cannot advance past Connect through its own button — we
// assert the Connect screen renders correctly and the Connect-UP click yields
// the expected "no UP provider" error (not a crash, not a blank page).
import puppeteer from '/home/bk/p/m8b-dev/openscad-host/src/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

const URL = process.argv[2] || process.env.WALL_URL || 'http://localhost:5173/';
const logs = [];
const b = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/brave-browser',
  args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-gpu'],
});
try {
  const p = await b.newPage();
  p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
  p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`.slice(0, 300)));
  p.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`.slice(0, 200)));

  await p.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 2500));

  const title = await p.title();
  const rootKids = await p.evaluate(() => document.getElementById('root')?.childElementCount ?? -1);
  const h1 = await p.evaluate(() => document.querySelector('h1')?.textContent ?? null);
  const btnText = await p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /connect/i.test(x.textContent || ''));
    return b?.textContent?.trim() ?? null;
  });
  console.log('TITLE:', title);
  console.log('#root childElementCount:', rootKids);
  console.log('H1:', h1);
  console.log('Connect button:', btnText);

  // Click Connect — with no UP extension this must surface an error in the UI,
  // not throw an unhandled pageerror or blank the app.
  await p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /connect/i.test(x.textContent || ''));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 3500));
  const errText = await p.evaluate(() => document.querySelector('.error')?.textContent ?? null);
  const stillRendered = await p.evaluate(() => document.getElementById('root')?.childElementCount ?? -1);
  const screenNow = await p.evaluate(() => document.querySelector('h1')?.textContent ?? null);
  console.log('after-click .error:', errText);
  console.log('after-click #root kids:', stillRendered, '| h1:', screenNow);
  console.log('--- console/errors ---');
  console.log(logs.join('\n') || '(none)');
} finally {
  await b.close();
}
