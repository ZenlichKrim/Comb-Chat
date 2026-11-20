/* Maps require('electron') to a stand-in so main-process code runs under Node. */
const Module = require('node:module')
const path = require('node:path')
const original = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
  return original.call(this, request, ...rest)
}
