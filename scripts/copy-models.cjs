const fs = require('fs');
const path = require('path');

const src = path.resolve(
  __dirname,
  '../node_modules/@vladmandic/face-api/model'
);
const dst = path.resolve(__dirname, '../public/models');

fs.mkdirSync(dst, { recursive: true });

for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  const to = path.join(dst, name);
  fs.copyFileSync(from, to);
}

console.log('✔ Models copiados: @vladmandic/face-api/model -> public/models');
