/**
 * Validacion del esquema GraphQL (job lint-build del CI):
 *   1. El SDL compila (sintaxis y tipos validos).
 *   2. Cada campo de Query y Mutation tiene resolver (y no hay resolvers huerfanos).
 *   3. Las operaciones del frontend (frontend/src/graphql/*.graphql) son validas contra el esquema.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, parse, validate } from 'graphql';
import { createResolvers } from '../src/resolvers.js';

const sdl = readFileSync(new URL('../src/schema.graphql', import.meta.url), 'utf8');
const schema = buildSchema(sdl);
const errors: string[] = [];

// Dependencias vacias: solo se inspeccionan los nombres de los resolvers, no se ejecutan.
const resolvers = createResolvers({ backends: {} } as never) as Record<string, Record<string, unknown>>;
for (const rootName of ['Query', 'Mutation'] as const) {
  const type = schema.getType(rootName);
  if (!type || !('getFields' in type)) continue;
  const fields = Object.keys(type.getFields());
  const implemented = Object.keys(resolvers[rootName] ?? {});
  for (const f of fields) if (!implemented.includes(f)) errors.push(`${rootName}.${f} no tiene resolver`);
  for (const r of implemented) if (!fields.includes(r)) errors.push(`Resolver ${rootName}.${r} no existe en el esquema`);
}

const opsDir = new URL('../../frontend/src/graphql/', import.meta.url);
let operations = 0;
if (existsSync(opsDir)) {
  for (const file of readdirSync(opsDir).filter((f) => f.endsWith('.graphql'))) {
    const doc = parse(readFileSync(join(opsDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), file), 'utf8'));
    operations += doc.definitions.length;
    for (const e of validate(schema, doc)) errors.push(`${file}: ${e.message}`);
  }
}

if (errors.length) {
  process.stderr.write(`Esquema GraphQL invalido:\n - ${errors.join('\n - ')}\n`);
  process.exit(1);
}
process.stdout.write(
  `Esquema GraphQL valido: ${Object.keys(schema.getQueryType()!.getFields()).length} queries, ` +
    `${Object.keys(schema.getMutationType()!.getFields()).length} mutations, ${operations} operaciones del frontend validadas.\n`,
);
