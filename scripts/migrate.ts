import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

/**
 * Execute SQL against Supabase using REST API.
 */
async function executeSQL(sql: string): Promise<void> {
  const config = getConfig();
  const url = `${config.SUPABASE_URL}/rest/v1/rpc/exec_sql`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ sql }),
    });

    if (!response.ok) {
      // Try alternative: direct SQL endpoint (if available)
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    // Supabase doesn't expose direct SQL execution via REST API
    // Fall back to file output
    throw error;
  }
}

/**
 * Run database migrations.
 */
async function runMigrations() {
  console.log('🚀 Database Migration Script\n');

  const migrations = [
    {
      name: 'Initial Schema',
      file: join(ROOT_DIR, 'src/supabase/schema.sql'),
    },
    {
      name: 'Add Specification Fields',
      file: join(ROOT_DIR, 'src/supabase/migrations/add_specification_fields.sql'),
    },
    {
      name: 'Create Kalshi Trades Table',
      file: join(ROOT_DIR, 'src/supabase/migrations/create_kalshi_trades.sql'),
    },
  ];

  console.log('📋 Migration Plan:');
  migrations.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.name}`);
  });
  console.log('');

  // Read all SQL files
  const sqlStatements: string[] = [];
  
  for (const migration of migrations) {
    try {
      const sql = readFileSync(migration.file, 'utf-8');
      sqlStatements.push(`-- ${migration.name}\n${sql}\n`);
      console.log(`✅ Read: ${migration.name}`);
    } catch (error) {
      console.error(`❌ Error reading ${migration.name}:`, error);
      process.exit(1);
    }
  }

  const combinedSQL = sqlStatements.join('\n\n');

  // Save combined SQL to file
  const outputFile = join(ROOT_DIR, 'migrations.sql');
  writeFileSync(outputFile, combinedSQL);
  console.log(`\n✅ Combined SQL saved to: ${outputFile}\n`);

  console.log('📌 To apply migrations, use one of these methods:\n');
  
  console.log('Option 1: Supabase Dashboard (Recommended)');
  console.log('  1. Go to: https://supabase.com/dashboard/project/_/sql');
  console.log('  2. Replace "_" with your project ID');
  console.log('  3. Copy contents of migrations.sql');
  console.log('  4. Paste into SQL Editor and click "Run"\n');

  console.log('Option 2: Supabase CLI');
  console.log('  If you have Supabase CLI installed:');
  console.log('  supabase db push\n');
  console.log('  Or link and push:');
  console.log('  supabase link --project-ref <your-project-ref>');
  console.log('  supabase db push\n');

  console.log('Option 3: psql (Direct PostgreSQL)');
  console.log('  Get connection string from Supabase dashboard:');
  console.log('  Settings → Database → Connection string → URI');
  console.log(`  psql "$DATABASE_URL" < ${outputFile}\n`);

  console.log('Option 4: Copy SQL manually');
  console.log('─'.repeat(80));
  console.log(combinedSQL);
  console.log('─'.repeat(80));
}

runMigrations().catch((error) => {
  console.error('Migration script error:', error);
  process.exit(1);
});
