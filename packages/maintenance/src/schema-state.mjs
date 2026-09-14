// Stable catalog descriptions, excluding migration bookkeeping and data values.
// Include objects Prisma does not model, so custom triggers/views are never
// silently adopted as a known ServerForge schema.
export async function schemaState(db) {
  return db.$queryRawUnsafe(`
    SELECT kind, name, definition FROM (
      SELECT 'relation' AS kind, c.relname AS name,
        c.relkind::text || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND c.relname <> '_prisma_migrations'
      UNION ALL
      SELECT 'column', c.relname || '.' || a.attname,
        format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin,d.adrelid),'')
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND c.relname <> '_prisma_migrations' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint', c.relname || '.' || x.conname, pg_get_constraintdef(x.oid)
      FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname <> '_prisma_migrations'
      UNION ALL
      SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename <> '_prisma_migrations'
      UNION ALL
      SELECT 'enum', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
      FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public' GROUP BY t.typname
      UNION ALL
      SELECT 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
      UNION ALL
      SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.prokind::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      UNION ALL
      SELECT 'policy', tablename || '.' || policyname, cmd || ':' || COALESCE(qual,'') FROM pg_policies WHERE schemaname='public'
    ) objects ORDER BY kind COLLATE "C", name COLLATE "C", definition COLLATE "C"
  `);
}

export function schemaDifference(expected, actual) {
  const before = new Map(expected.map((row) => [`${row.kind}:${row.name}`, row.definition]));
  const after = new Map(actual.map((row) => [`${row.kind}:${row.name}`, row.definition]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((key) => {
    if (!before.has(key)) return [`Unexpected ${key}`];
    if (!after.has(key)) return [`Missing ${key}`];
    return before.get(key) === after.get(key) ? [] : [`Changed ${key}`];
  });
}
