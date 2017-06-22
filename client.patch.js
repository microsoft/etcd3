const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'client.patch.txt');
const target = path.join(path.dirname(require.resolve('grpc')), 'src', 'client.js');

fs.createReadStream(source)
  .pipe(fs.createWriteStream(target));
