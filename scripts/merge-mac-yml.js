'use strict';
// Merge two electron-builder update manifests (per-arch builds overwrite
// latest-mac.yml, they don't merge). Usage:
//   node scripts/merge-mac-yml.js <first.yml> <second.yml> <out.yml>
const fs = require('fs');
const yaml = require('js-yaml'); // ships with electron-builder's deps

const [a, b, out] = process.argv.slice(2);
const first = yaml.load(fs.readFileSync(a, 'utf8'));
const second = yaml.load(fs.readFileSync(b, 'utf8'));
if (first.version !== second.version) {
  console.error(`version mismatch: ${first.version} vs ${second.version}`);
  process.exit(1);
}
second.files = [
  ...second.files,
  ...first.files.filter((f) => !second.files.some((g) => g.url === f.url)),
];
fs.writeFileSync(out, yaml.dump(second, { lineWidth: 8000 }));
console.log(`merged ${second.files.length} file entries -> ${out}`);
