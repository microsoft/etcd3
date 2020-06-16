module.exports = {
  require: ['source-map-support/register', './lib/test/_setup.js'],
  timeout: 10 * 1000,
  exit: true,
  spec: 'lib/test/**/*.test.js'
};
