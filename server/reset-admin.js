'use strict';
// Gives the user "admin" a new one-time password that must be changed at the next login, and prints it
// on stdout. Run by `beeldkrant-station --reset-admin` as the service user while Beeldkrant is stopped.
const auth = require('./auth');

process.stdout.write(`${auth.resetAdmin()}\n`);
