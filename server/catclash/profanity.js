'use strict';

// Small blocklist to catch obvious names / answers. Not exhaustive — the host
// can kick players and re-bucket answers too. Copied from the other games so
// name handling is consistent across the hub.
const BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'b1tch', 'bich', 'cunt', 'asshole', 'dick', 'pussy', 'cock',
  'nigger', 'nigga', 'faggot', 'retard', 'slut', 'whore', 'hoe', 'ho', 'bastard',
  'fck', 'sh1t', 'a55hole', 'fuk', 'phuck', 'ass', 'sht', 'motherfucker'
];

function isBlocked(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!n) return false;
  return BLOCKLIST.some((bad) => n.includes(bad));
}

module.exports = { isBlocked };
