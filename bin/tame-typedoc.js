'use strict';

const path = require('path');
const root = path.resolve(__dirname, '..', 'docs');
const fs = require('fs');
const _ = require('lodash');

const files = [];
function gatherFiles(dir = root) {
  fs.readdirSync(dir).forEach(file => {
    file = path.join(dir, file);
    if (fs.statSync(file).isDirectory()) {
      gatherFiles(file);
    } else if (path.extname(file) === '.html') {
      files.push(file);
    }
  });
}

function replaceAll(haystack, needle, replacement) {
  return haystack.replace(new RegExp(_.escapeRegExp(needle), 'g'), replacement);
}

function ununderscore() {
  const replacements = [];
  files.forEach((file, i) => {
    const basename = path.basename(file);
    if (basename[0] !== '_') {
      return;
    }

    const adjusted = path.join(path.dirname(file), basename.slice(1));
    replacements.push({ from: basename, to: basename.slice(1) });

    fs.renameSync(file, adjusted);
    files[i] = adjusted;
  });

  files.forEach(file => {
    let contents = fs.readFileSync(file, 'utf8');
    replacements.forEach(({ from, to }) => {
      contents = replaceAll(contents, from, to);
    });
    fs.writeFileSync(file, contents);
  });
}

gatherFiles();
ununderscore();
