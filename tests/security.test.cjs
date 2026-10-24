// Security regression test for Folio.
// Run (dev build only):  npm run build:renderer && FOLIO_TEST_SCRIPT=tests/security.test.cjs npx electron .
// PowerShell:             $env:FOLIO_TEST_SCRIPT="tests/security.test.cjs"; npx electron .
// Exits with code 0 when every check passes, 1 otherwise. Nothing is really opened or run:
// shell.openPath / openExternal / message boxes are replaced with fakes for the test.
const { shell, dialog, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const opened = [];
const boxes = [];
shell.openPath = async (p) => { opened.push(path.basename(p)); return ''; };
shell.openExternal = async () => {};
dialog.showMessageBox = async (_w, o) => { boxes.push(o.message); return { response: 0 }; }; // always "Cancel"/"OK"

function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-sec-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), path.join(dir, 'assets', 'pic.png'));
  fs.writeFileSync(path.join(dir, 'setup.exe'), 'not really a program');
  fs.writeFileSync(path.join(dir, 'run.bat'), 'echo hi');
  fs.writeFileSync(path.join(dir, 'report.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(dir, 'data.zip'), 'zip');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'TOP SECRET');
  fs.writeFileSync(path.join(dir, 'page.html'), '<script>1</script>');
  const md = [
    '# Test',
    '',
    '![local](assets/pic.png)',
    '',
    '![unc](//attacker.invalid/share/x.png)',
    '',
    '[exe](setup.exe) [bat](run.bat) [trailing](setup.exe.) [pdf](report.pdf) [zip](data.zip) [unclink](//attacker.invalid/share/a.exe)',
    '',
    '- [ ] task',
    '',
    // other ways a document can point at a network share (each one = zero-click SMB on Windows)
    '<img src="x.png" srcset="//attacker.invalid/share/srcset.png 2x">',
    '<picture><source srcset="//attacker.invalid/share/picture.png"><img src="y.png"></picture>',
    '<p style="background:url(//attacker.invalid/share/style.png)">s</p>',
    '<video src="//attacker.invalid/share/v.mp4" poster="//attacker.invalid/share/poster.png"></video>',
    '<audio src="//attacker.invalid/share/a.mp3"></audio>',
    '<svg><image href="//attacker.invalid/share/svg.png" width="9" height="9"/></svg>',
    '<input type="image" src="//attacker.invalid/share/input.png">',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'test.md'), md);
  return dir;
}

module.exports = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok) => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
  const dir = makeFixtures();
  const mdPath = path.join(dir, 'test.md');
  const original = fs.readFileSync(mdPath, 'utf8');
  // Every request to the fake server must end as ERR_BLOCKED_BY_CLIENT (= cancelled by Folio's
  // filter before Windows could connect). Anything else means it got through.
  const remoteReqs = [];
  const wr = session.defaultSession.webRequest;
  const rec = (d, outcome) => { if (d.url.includes('attacker.invalid') && d.url.startsWith('file:')) remoteReqs.push([d.url, outcome]); };
  wr.onErrorOccurred((d) => rec(d, d.error));
  wr.onCompleted((d) => rec(d, 'completed'));
  try {
    await wait(1200);
    const probe = (p) => js(`new Promise((r)=>{const i=new Image();i.onload=()=>r(true);i.onerror=()=>r(false);i.src='folio://local/'+encodeURIComponent(${JSON.stringify(p)});})`);
    check('folio:// serves local images', await probe(path.join(dir, 'assets', 'pic.png')));
    check('folio:// refuses non-image files', !(await probe(path.join(dir, 'secret.txt'))) && !(await probe(path.join(dir, 'page.html'))));
    check('folio:// refuses UNC paths', !(await probe('//attacker.invalid/share/x.png')) && !(await probe('\\\\attacker.invalid\\share\\x.png')));

    await js(`window.__folio.openFile(${JSON.stringify(mdPath)}, { mode: 'read' })`);
    await wait(800);
    const click = (t) => js(`[...document.querySelectorAll('#reader a')].find((a) => a.textContent === ${JSON.stringify(t)})?.click()`);
    for (const t of ['exe', 'bat', 'trailing', 'pdf', 'zip', 'unclink']) { await click(t); await wait(300); }
    check('links never launch programs', !opened.some((n) => /\.(exe|bat)\.?$/i.test(n)));
    check('blocked-program warning shown', boxes.filter((m) => m.includes("won't run")).length >= 2);
    check('unknown file types ask first (and Cancel = not opened)', boxes.some((m) => m.includes('data.zip')) && !opened.includes('data.zip'));
    check('safe documents open directly', opened.includes('report.pdf'));
    check('UNC links are not opened', !opened.some((n) => n === 'a.exe'));
    check('local image renders', await js(`(()=>{const i=document.querySelector('#reader img[alt=local]');return !!i && i.naturalWidth>0})()`));
    check('read toolbar buttons work', await js(`(()=>{document.querySelector('#toolbar-read [data-r=export]').click();const ok=!!document.querySelector('.menu');document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return ok})()`));
    const leaks = remoteReqs.filter(([, o]) => o !== 'net::ERR_BLOCKED_BY_CLIENT');
    leaks.forEach(([u, o]) => console.log(`      leaked: ${u} (${o})`));
    check('no HTML attribute can reach a network share', remoteReqs.length >= 7 && leaks.length === 0);
    check('opening a file never changes it on disk', fs.readFileSync(mdPath, 'utf8') === original);
  } catch (e) {
    check(`test crashed: ${e.message}`, false);
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll security checks passed');
  app.exit(failed ? 1 : 0);
};
