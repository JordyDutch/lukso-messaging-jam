import puppeteer from '/home/bk/p/m8b-dev/openscad-host/src/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
const URL = process.argv[2] || 'https://vpn-node.internal/app/';
const b = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/brave-browser',
  args: ['--no-sandbox','--ignore-certificate-errors','--disable-gpu']
});
const p = await b.newPage();
const logs = [];
p.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
p.on('requestfailed', r => logs.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`));
try {
  await p.goto(URL, {waitUntil:'networkidle2', timeout:45000});
} catch(e){ logs.push(`[goto] ${e.message}`); }
await new Promise(r=>setTimeout(r,6000));
const rootKids = await p.evaluate(()=>document.getElementById('root')?.childElementCount ?? -1);
const title = await p.title();
const bodyText = await p.evaluate(()=>document.body?.innerText?.slice(0,400) ?? '');
console.log('TITLE:', title);
console.log('#root childElementCount:', rootKids);
console.log('--- body text (first 400) ---');
console.log(bodyText.replace(/\n{2,}/g,'\n'));
console.log('--- console/errors ---');
console.log(logs.join('\n') || '(none)');
await b.close();
