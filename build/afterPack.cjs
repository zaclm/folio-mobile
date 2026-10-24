// Sets the Windows .exe icon and version info without needing Wine/rcedit
// (lets the Windows installer be built on Linux or macOS too).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const R = ResEdit.default || ResEdit;
  const pkg = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${pkg.productFilename}.exe`);
  const exe = R.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = R.NtExecutableResource.from(exe);

  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
  const iconId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconId, lang, ico.icons.map((i) => i.data));

  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0] || R.Resource.VersionInfo.createEmpty();
  const v = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
  while (v.length < 4) v.push(0);
  vi.setFileVersion(...v, 1033);
  vi.setProductVersion(...v, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Folio',
    ProductName: 'Folio',
    CompanyName: 'Zac',
    LegalCopyright: 'Copyright © 2026 Zac',
    OriginalFilename: `${pkg.productFilename}.exe`,
    InternalName: 'Folio',
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • afterPack: icon + version info written to', path.basename(exePath));
};
