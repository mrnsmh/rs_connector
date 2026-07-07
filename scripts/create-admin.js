'use strict';

/**
 * CLI de bootstrap : crée le premier compte admin du back-office (Task 9).
 *
 *   node scripts/create-admin.js <username> <password>
 *   ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/create-admin.js
 *
 * La 2FA (TOTP) n'est pas activée à la création : elle se configure ensuite depuis le
 * back-office (POST /admin/totp/setup puis /admin/totp/enable).
 */

const { Pool } = require('pg');
const config = require('../src/config');
const { createDb } = require('../src/db');
const { hashPassword } = require('../src/admin/password');

async function main() {
  const username = process.argv[2] || process.env.ADMIN_USERNAME;
  const password = process.argv[3] || process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.error('Usage : node scripts/create-admin.js <username> <password>');
    console.error('   ou : ADMIN_USERNAME=... ADMIN_PASSWORD=... node scripts/create-admin.js');
    process.exit(1);
  }
  if (String(password).length < 12) {
    console.error('Mot de passe trop court (12 caractères minimum recommandés).');
    process.exit(1);
  }

  const pool = new Pool(config.database);
  const db = createDb(pool);
  try {
    const existing = await db.getAdminUserByUsername(username);
    if (existing) {
      console.error(`L'admin "${username}" existe déjà (id ${existing.id}). Abandon.`);
      process.exit(2);
    }
    const user = await db.createAdminUser({ username, passwordHash: hashPassword(password) });
    console.log(`Admin créé : ${user.username} (id ${user.id}).`);
    console.log('2FA non activée — configurez-la via le back-office (/admin/totp/setup → /admin/totp/enable).');
  } finally {
    await db.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Échec de création de l\'admin :', err.message);
  process.exit(1);
});
